import { Suspense, lazy, useEffect, type JSX } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import { useAuth } from './stores/auth';

const Login = lazy(() => import('./pages/Login'));
const Signup = lazy(() => import('./pages/Signup'));
const Letters = lazy(() => import('./pages/Letters'));
const Compose = lazy(() => import('./pages/Compose'));
const Reader = lazy(() => import('./pages/Reader'));
const Pairing = lazy(() => import('./pages/Pairing'));
const Play = lazy(() => import('./pages/Play'));
const Settings = lazy(() => import('./pages/Settings'));

/**
 * The access token lives in memory only (see stores/auth), so a page load has
 * nothing to restore from storage. We exchange the httpOnly refresh cookie for
 * a token before rendering anything that needs it. That is why there is a
 * `restoring` state and why the app does not flash the sign-in screen on reload.
 */
function Boot({ children }: { children: JSX.Element }) {
  const restoring = useAuth((s) => s.restoring);

  useEffect(() => {
    void useAuth.getState().restore();
  }, []);

  if (restoring) {
    return (
      <main id="main">
        <p className="muted">Opening your archive…</p>
      </main>
    );
  }
  return children;
}

function RequireAuth({ children }: { children: JSX.Element }) {
  const authenticated = useAuth((s) => s.authenticated);
  if (!authenticated) return <Navigate to="/login" replace />;
  return children;
}

/** Keeps signed-in users off the auth screens. */
function RedirectIfAuthed({ children }: { children: JSX.Element }) {
  const authenticated = useAuth((s) => s.authenticated);
  if (authenticated) return <Navigate to="/letters" replace />;
  return children;
}

function NotFound() {
  return (
    <main id="main">
      <div className="card">
        <h1>Nothing here</h1>
        <p className="muted">That page does not exist.</p>
        <a className="button" href="/letters">
          Back to your archive
        </a>
      </div>
    </main>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense
        fallback={
          <main id="main">
            <p className="muted">Loading…</p>
          </main>
        }
      >
        <Boot>
          <Routes>
            <Route
              path="/login"
              element={
                <RedirectIfAuthed>
                  <Login />
                </RedirectIfAuthed>
              }
            />
            <Route
              path="/signup"
              element={
                <RedirectIfAuthed>
                  <Signup />
                </RedirectIfAuthed>
              }
            />

            <Route
              element={
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              }
            >
              <Route path="/" element={<Navigate to="/letters" replace />} />
              <Route path="/letters" element={<Letters />} />
              <Route path="/letters/new" element={<Compose />} />
              <Route path="/letters/:id" element={<Reader />} />
              <Route path="/pairing" element={<Pairing />} />
              <Route path="/play" element={<Play />} />
              <Route path="/settings" element={<Settings />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </Boot>
      </Suspense>
    </BrowserRouter>
  );
}