import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, AuthProvider } from '@smt/ui';
import '@smt/ui/src/tokens.css';
import { MeProvider } from './session';
import { App } from './App';

const queryClient = new QueryClient({
  defaultOptions: {
    // Pas de nouvel essai sur un refus (droits, introuvable, règle métier).
    queries: { retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider clientId="portail">
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <MeProvider>
            <App />
          </MeProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </AuthProvider>
  </StrictMode>,
);
