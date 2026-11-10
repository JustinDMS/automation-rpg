import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Repl } from './Repl';
import './game.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Repl />
  </StrictMode>,
);
