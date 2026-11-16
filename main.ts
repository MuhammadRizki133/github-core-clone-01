// Entrypoint for the forge bot.
//
// This file owns only the conversation with the make.fun environment: it
// boots the app on a kernel-assigned port, announces that port to the env,
// then waits until the env says the run is finished before shutting down.
// All of the actual forge behaviour lives behind createApp() in app.ts.

import { createApp } from './app.ts';

// Every env request gets a generous but finite timeout so a hung socket
// cannot stall the run forever.
const REQUEST_TIMEOUT_MS = 30_000;

// Retry pacing, shared by the registration loop and the done-polling loop:
// start quick, double after each miss, never sleep longer than the cap.
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A tiny stateful backoff: each call waits the current delay and then grows
// it for the next call. A fresh one is made per phase so the polling loop
// does not inherit registration's already-grown delay.
function makeBackoff(): () => Promise<void> {
  let pause = FIRST_PAUSE_MS;
  return async () => {
    await sleep(pause);
    pause = Math.min(pause * 2, LONGEST_PAUSE_MS);
  };
}

// The env base URL comes from MAKEFUN_ENV_URL. Trailing slashes are dropped
// so paths can be appended with a single '/'. A missing or blank value is a
// configuration error and there is nothing sensible to do but bail out.
function envBaseUrl(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  const base = raw.trim().replace(/\/+$/, '');
  if (base.length === 0) {
    console.error('main: MAKEFUN_ENV_URL is not set; nowhere to register, exiting.');
    process.exit(1);
  }
  return base;
}

// POST our port to the env until it accepts. 200 means registered; 409
// means someone else registered first, which is fine — the env knows a port
// either way, so we proceed. 400/405 mean the env will never accept this
// request shape, so those are fatal. Anything else (including network
// errors and timeouts) is treated as transient and retried forever.
async function registerWithEnv(base: string, port: number): Promise<void> {
  const pause = makeBackoff();
  for (;;) {
    let status: number | undefined;
    try {
      const res = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
    } catch {
      status = undefined; // network error or timeout: fall through to retry
    }

    if (status === 200 || status === 409) return;
    if (status === 400 || status === 405) {
      throw new Error(`registration rejected by env with HTTP ${status}; not retrying`);
    }
    await pause();
  }
}

// Poll the env's /done endpoint until it reports completion. Any response
// that is not a JSON body with done === true — wrong status, unparseable
// body, done still false, or a failed request — just means "not yet".
async function waitForDone(base: string): Promise<void> {
  const pause = makeBackoff();
  for (;;) {
    let finished = false;
    try {
      const res = await fetch(`${base}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body: unknown = await res.json();
        finished =
          typeof body === 'object' &&
          body !== null &&
          (body as { done?: unknown }).done === true;
      }
    } catch {
      finished = false;
    }
    if (finished) return;
    await pause();
  }
}

async function run(): Promise<void> {
  const base = envBaseUrl();

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server is listening but reported no port');
  }
  const port = address.port;
  console.log(`main: forge is listening on port ${port}`);

  await registerWithEnv(base, port);
  console.log(`main: registered with env at ${base}`);

  await waitForDone(base);
  console.log('main: env signalled done; closing the forge');

  server.close();
  process.exit(0);
}

try {
  await run();
} catch (err) {
  console.error('main: fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
}
