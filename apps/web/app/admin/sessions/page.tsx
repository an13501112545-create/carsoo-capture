'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';

interface SessionRow {
  id: number;
  status: string;
  vin?: string;
  plate?: string;
  created_at: string;
  missing_required: number;
}

interface NotificationChannel {
  to?: string;
  message?: string;
  subject?: string;
  body?: string;
}

interface CreateSessionNotifications {
  sms?: NotificationChannel | null;
  email?: NotificationChannel | null;
}

export default function AdminSessionsPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({
    seller_name: '',
    seller_phone: '',
    seller_email: '',
    listing_id: '',
    vin: '',
    plate: '',
    province: '',
    vehicle_make: '',
    vehicle_model: '',
    vehicle_year: ''
  });
  const [link, setLink] = useState('');
  const [notifications, setNotifications] = useState<CreateSessionNotifications | null>(null);

  const loadSessions = async () => {
    const token = localStorage.getItem('carsoo_admin_token');
    if (!token) return;
    const resp = await fetch(`${API_BASE}/api/admin/sessions`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!resp.ok) {
      setNotice('Failed to load sessions');
      return;
    }
    const data = await resp.json();
    setSessions(data);
  };

  useEffect(() => {
    loadSessions();
  }, []);

  const createSession = async () => {
    setNotice('');
    setLink('');
    setNotifications(null);
    const token = localStorage.getItem('carsoo_admin_token');
    if (!token) {
      setNotice('Please login again.');
      return;
    }
    const resp = await fetch(`${API_BASE}/api/admin/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(form)
    });
    if (!resp.ok) {
      setNotice('Failed to create session');
      return;
    }
    const data = await resp.json();
    setLink(data.link);
    setNotifications(data.notifications || null);
    await loadSessions();
  };

  return (
    <main>
      <div className="grid two">
        <div className="card">
          <h1>Create session</h1>
          {notice && <div className="alert">{notice}</div>}
          {link && (
            <div className="alert">
              <p>
                Seller link: <a href={link}>{link}</a>
              </p>
              {notifications?.sms && (
                <div style={{ marginTop: '0.75rem' }}>
                  <strong>SMS</strong>
                  <p>To: {notifications.sms.to || '-'}</p>
                  <p>Message: {notifications.sms.message || '-'}</p>
                </div>
              )}
              {notifications?.email && (
                <div style={{ marginTop: '0.75rem' }}>
                  <strong>Email</strong>
                  <p>To: {notifications.email.to || '-'}</p>
                  <p>Subject: {notifications.email.subject || '-'}</p>
                  <p>Body: {notifications.email.body || '-'}</p>
                </div>
              )}
            </div>
          )}
          <div className="grid two">
            <label>
              Seller name
              <input value={form.seller_name} onChange={(e) => setForm({ ...form, seller_name: e.target.value })} />
            </label>
            <label>
              Seller phone
              <input value={form.seller_phone} onChange={(e) => setForm({ ...form, seller_phone: e.target.value })} />
            </label>
            <label>
              Seller email
              <input value={form.seller_email} onChange={(e) => setForm({ ...form, seller_email: e.target.value })} />
            </label>
            <label>
              Listing ID
              <input value={form.listing_id} onChange={(e) => setForm({ ...form, listing_id: e.target.value })} />
            </label>
            <label>
              VIN
              <input value={form.vin} onChange={(e) => setForm({ ...form, vin: e.target.value })} />
            </label>
            <label>
              Plate
              <input value={form.plate} onChange={(e) => setForm({ ...form, plate: e.target.value })} />
            </label>
            <label>
              Province
              <input value={form.province} onChange={(e) => setForm({ ...form, province: e.target.value })} />
            </label>
            <label>
              Make
              <input value={form.vehicle_make} onChange={(e) => setForm({ ...form, vehicle_make: e.target.value })} />
            </label>
            <label>
              Model
              <input value={form.vehicle_model} onChange={(e) => setForm({ ...form, vehicle_model: e.target.value })} />
            </label>
            <label>
              Year
              <input value={form.vehicle_year} onChange={(e) => setForm({ ...form, vehicle_year: e.target.value })} />
            </label>
          </div>
          <button className="button" style={{ marginTop: '1rem' }} onClick={createSession}>
            Generate link
          </button>
        </div>

        <div className="card">
          <h1>Sessions</h1>
          <div className="step-list">
            {sessions.map((session) => (
              <div key={session.id} className="card">
                <p>
                  <strong>#{session.id}</strong> {session.vin || 'VIN TBD'} • {session.plate || 'Plate TBD'}
                </p>
                <p>Status: <span className="tag">{session.status}</span></p>
                <p>Missing required: {session.missing_required}</p>
                <Link className="button" href={`/admin/sessions/${session.id}`}>
                  Review session
                </Link>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
