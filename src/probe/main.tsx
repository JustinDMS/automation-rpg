import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Probe } from './Probe';
import './probe.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Probe />
  </StrictMode>,
);
