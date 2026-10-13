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
