import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Repl } from './Repl';
import './probe.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Repl />
  </StrictMode>,
);
