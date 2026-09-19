import { useTheme } from '../stores/theme';

export default function Settings() {
  const { theme, toggle } = useTheme();
  return (
    <div className="card">
      <h1>Settings</h1>
      <p className="muted">Current theme: {theme}</p>
      <button onClick={toggle}>Toggle theme</button>
    </div>
  );
}
