import { create } from 'zustand';

interface User {
  id: number;
  username: string;
  email?: string;
}

interface AuthState {
  token: string | null;
  user: User | null;
  login: (token: string, user: User) => void;
  logout: () => void;
}

const storedToken = localStorage.getItem('pp_token');
const storedUser = localStorage.getItem('pp_user');

export const useAuth = create<AuthState>((set) => ({
  token: storedToken,
  user: storedUser ? (JSON.parse(storedUser) as User) : null,
  login: (token, user) => {
    localStorage.setItem('pp_token', token);
    localStorage.setItem('pp_user', JSON.stringify(user));
    set({ token, user });
  },
  logout: () => {
    localStorage.removeItem('pp_token');
    localStorage.removeItem('pp_user');
    set({ token: null, user: null });
  },
}));
