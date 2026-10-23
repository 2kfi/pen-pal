import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Order matters: fonts declare faces, tokens declare the variables, index.css
// consumes both.
import './fonts.css';
import './tokens.css';
import './index.css';
import './chess.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

/*
 * The offline shell. Production only, so a dev server never fights you with a
 * stale cached bundle — the most expensive way to lose an hour — and after
 * load, so the first visit is never racing the worker that would cache it.
 * See public/sw.js for what it keeps, and what it refuses to touch.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js');
  });
}
