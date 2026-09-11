import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div style={{ padding: 'var(--sp-24) 0', maxWidth: 520 }}>
      <h1 className="greeting" style={{ marginBottom: 'var(--sp-4)' }}>This door opens on nothing.</h1>
      <p className="page-desc" style={{ marginBottom: 'var(--sp-6)' }}>
        That page isn’t part of OpusHub. The lights are still on in the Hub, though.
      </p>
      <Link className="btn btn-primary" to="/">Back to the Hub</Link>
    </div>
  );
}
