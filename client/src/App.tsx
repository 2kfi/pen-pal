import { Suspense, lazy, type JSX } from 'react';
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

function Loading() {
  return (
    <main id="main">
      <p className="muted">Opening the archive…</p>
    </main>
  );
}

/**
 * Checks for a token only — not for an unlocked key. Key residency is enforced
 * inside <Layout>, because "signed in" and "able to read" are different states and
 * conflating them hides the difference from the user.
 */
function RequireAuth({ children }: { children: JSX.Element }) {
  const token = useAuth((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

/** Keeps signed-in users off the auth screens. */
function RedirectIfAuthed({ children }: { children: JSX.Element }) {
  const token = useAuth((s) => s.token);
  if (token) return <Navigate to="/letters" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Loading />}>
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

          <Route path="*" element={<Navigate to="/letters" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}