'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('admin@carsoo.ai');
  const [password, setPassword] = useState('admin123');
  const [notice, setNotice] = useState('');

  const handleLogin = async () => {
    setNotice('');
    const resp = await fetch(`${API_BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (!resp.ok) {
      setNotice('Login failed');
      return;
    }
    const data = await resp.json();
    localStorage.setItem('carsoo_admin_token', data.token);
    router.push('/admin/sessions');
  };

  return (
    <main>
      <div className="card" style={{ maxWidth: '420px', margin: '0 auto' }}>
        <h1>Admin Login</h1>
        {notice && <div className="alert">{notice}</div>}
        <label>
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="button" style={{ marginTop: '1rem' }} onClick={handleLogin}>
          Sign in
        </button>
      </div>
    </main>
  );
}
