import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthGate } from './components/Auth/AuthGate';
import { ToastProvider } from './components/Toast';
import { SSEProvider } from './hooks/useSSE';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <SSEProvider>
          <AuthGate>
            <App />
          </AuthGate>
        </SSEProvider>
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
);
