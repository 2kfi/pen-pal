import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import { useAuth } from './stores/auth';
import type { JSX } from 'react';

const Login = lazy(() => import('./pages/Login'));
const Letters = lazy(() => import('./pages/Letters'));
const Compose = lazy(() => import('./pages/Compose'));
const Reader = lazy(() => import('./pages/Reader'));
const Pairing = lazy(() => import('./pages/Pairing'));
const Media = lazy(() => import('./pages/Media'));
const Games = lazy(() => import('./pages/Games'));
const Settings = lazy(() => import('./pages/Settings'));

function Guard({ children }: { children: JSX.Element }) {
  const token = useAuth((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<main className="muted">Loading…</main>}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <Guard>
                <Layout />
              </Guard>
            }
          >
            <Route path="/" element={<Navigate to="/letters" replace />} />
            <Route path="/letters" element={<Letters />} />
            <Route path="/letters/new" element={<Compose />} />
            <Route path="/letters/:id" element={<Reader />} />
            <Route path="/pairing" element={<Pairing />} />
            <Route path="/media" element={<Media />} />
            <Route path="/games" element={<Games />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/letters" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
