import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from 'react-router';
import styles from './style.css?url';
export const links = () => [{ rel: 'stylesheet', href: styles }];
export const meta = () => [
  { title: 'Tendr · Shopify connector' },
  { name: 'robots', content: 'noindex, nofollow' },
];
export function Layout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <header>
          <a href="/app">
            <b>tendr</b>
            <span>Shopify connector</span>
          </a>
        </header>
        <main>{children}</main>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
export default function App() {
  return <Outlet />;
}
export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <section className="card">
      <h1>
        {isRouteErrorResponse(error) && error.status === 404
          ? 'Not found'
          : 'This request could not finish'}
      </h1>
      <p>
        Check the input and connector configuration, then retry. Existing payments keep the same
        reference.
      </p>
      <a href="/app">Return to connector</a>
    </section>
  );
}
