import { index, route } from '@react-router/dev/routes';
export default [
  index('routes/_index.jsx'),
  route('app', 'routes/app.jsx'),
  route('mock/:token', 'routes/mock.$token.jsx'),
  route('return/:token', 'routes/return.$token.jsx'),
  route('sim/order/:token', 'routes/sim.order.$token.jsx'),
];
