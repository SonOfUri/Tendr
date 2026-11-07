import { PassThrough } from 'node:stream';
import { createReadableStreamFromReadable } from '@react-router/node';
import { renderToPipeableStream } from 'react-dom/server';
import { ServerRouter } from 'react-router';
import { isbot } from 'isbot';

// Avoid logging bearer checkout tokens, OAuth query strings or provider bodies from route errors.
export function handleError(_error, { request }) {
  if (!request.signal.aborted) console.error('Shopify page request failed');
}
export default function handleRequest(request, status, headers, context) {
  return new Promise((resolve, reject) => {
    let shellRendered = false;
    const ready = isbot(request.headers.get('user-agent') || '') ? 'onAllReady' : 'onShellReady';
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={context} url={request.url} />,
      {
        [ready]() {
          shellRendered = true;
          const body = new PassThrough();
          headers.set('Content-Type', 'text/html');
          resolve(new Response(createReadableStreamFromReadable(body), { status, headers }));
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError() {
          status = 500;
          if (shellRendered) console.error('Shopify page render failed');
        },
      },
    );
    setTimeout(abort, 5000).unref();
  });
}
