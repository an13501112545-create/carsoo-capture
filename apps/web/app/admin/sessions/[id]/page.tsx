'use client';

import { useEffect, useMemo, useState } from 'react';
import { normalizePreviewUrl } from '../../../../lib/preview-url';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';

interface Asset {
  id: number;
  step_key: string;
  file_url: string;
  preview_url?: string;
}

interface ReviewDecision {
  step_key: string;
  decision: string;
  comment?: string;
}

interface SessionDetail {
  session: { id: number; status: string; vin?: string; plate?: string };
  assets: Asset[];
  reviews: ReviewDecision[];
}

interface Step {
  stepKey: string;
  title: string;
  description: string;
  required: boolean;
  minCount: number;
}

interface StepGroup {
  group: string;
  steps: Step[];
}

export default function AdminReviewPage({ params }: { params: { id: string } }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [groups, setGroups] = useState<StepGroup[]>([]);
  const [notice, setNotice] = useState('');

  const load = async () => {
    const token = localStorage.getItem('carsoo_admin_token');
    if (!token) return;
    const stepsResp = await fetch(`${API_BASE}/api/steps`);
    const stepsData = await stepsResp.json();
    setGroups(stepsData);
    const resp = await fetch(`${API_BASE}/api/admin/sessions/${params.id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!resp.ok) {
      setNotice('Failed to load session');
      return;
    }
    const data = await resp.json();
    setDetail(data);
  };

  useEffect(() => {
    load();
  }, []);

  const assetMap = useMemo(() => {
    const map: Record<string, Asset[]> = {};
    detail?.assets.forEach((asset) => {
      if (!map[asset.step_key]) {
        map[asset.step_key] = [];
      }
      map[asset.step_key].push(asset);
    });
    return map;
  }, [detail]);

  const reviewState = useMemo(() => {
    const map: Record<string, ReviewDecision> = {};
    detail?.reviews.forEach((review) => {
      map[review.step_key] = { ...review };
    });
    return map;
  }, [detail]);

  const updateReview = (stepKey: string, decision: string, comment?: string) => {
    if (!detail) return;
    const nextReviews = { ...reviewState, [stepKey]: { step_key: stepKey, decision, comment } };
    setDetail({ ...detail, reviews: Object.values(nextReviews) });
  };

  const saveReview = async () => {
    if (!detail) return;
    const token = localStorage.getItem('carsoo_admin_token');
    if (!token) return;
    const resp = await fetch(`${API_BASE}/api/admin/sessions/${detail.session.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(detail.reviews)
    });
    if (!resp.ok) {
      setNotice('Failed to save review');
      return;
    }
    setNotice('Review saved.');
  };

  if (!detail) {
    return <main>Loading...</main>;
  }

  return (
    <main>
      <div className="card">
        <h1>Review session #{detail.session.id}</h1>
        <p>Status: <span className="tag">{detail.session.status}</span></p>
        {notice && <div className="alert">{notice}</div>}
        <button className="button" onClick={saveReview}>Save review</button>
      </div>

      {groups.map((group) => (
        <div key={group.group} className="card" style={{ marginTop: '1.5rem' }}>
          <h2>{group.group}</h2>
          {group.steps.map((step) => {
            const assets = assetMap[step.stepKey] || [];
            const review = reviewState[step.stepKey];
            return (
              <div key={step.stepKey} style={{ marginBottom: '1rem' }}>
                <h3>{step.title}</h3>
                <div className="thumb-list">
                  {assets.map((asset) => {
                    const previewSrc = normalizePreviewUrl(asset.preview_url);
                    if (!previewSrc) {
                      return null;
                    }
                    return <img key={asset.id} className="thumb" src={previewSrc} alt={step.title} />;
                  })}
                </div>
                <div className="grid two" style={{ marginTop: '0.5rem' }}>
                  <select
                    value={review?.decision || 'pass'}
                    onChange={(e) => updateReview(step.stepKey, e.target.value, review?.comment)}
                  >
                    <option value="pass">PASS</option>
                    <option value="retake">RETAKE</option>
                  </select>
                  <input
                    placeholder="Comment"
                    value={review?.comment || ''}
                    onChange={(e) => updateReview(step.stepKey, review?.decision || 'pass', e.target.value)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </main>
  );
}
