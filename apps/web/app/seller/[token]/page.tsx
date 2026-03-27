'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';

interface Step {
  stepKey: string;
  title: string;
  description: string;
  example: string;
  required: boolean;
  minCount: number;
  mode: string;
}

interface StepGroup {
  group: string;
  steps: Step[];
}

interface Asset {
  id: number;
  step_key: string;
  file_url: string;
  preview_url?: string;
}

interface Review {
  step_key: string;
  decision: string;
  comment?: string;
}

interface SessionPayload {
  session: { status: string };
  assets: Asset[];
  reviews: Review[];
  missing_required: number;
  next_step_key?: string | null;
}

function toAbsoluteUrl(url: string | undefined): string {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `${API_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
}

export default function SellerCapturePage({ params }: { params: { token: string } }) {
  const { token } = params;
  const [groups, setGroups] = useState<StepGroup[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [sessionStatus, setSessionStatus] = useState<string>('draft');
  const [missingRequired, setMissingRequired] = useState<number>(0);
  const [activeStepKey, setActiveStepKey] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [uploading, setUploading] = useState<boolean>(false);
  const [notice, setNotice] = useState<string>('');
  const [agreeDocs, setAgreeDocs] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = async () => {
    const stepsResp = await fetch(`${API_BASE}/api/steps`);
    const stepsData = await stepsResp.json();
    const sessionResp = await fetch(`${API_BASE}/api/sessions/${token}`);
    const sessionData: SessionPayload = await sessionResp.json();
    setGroups(stepsData);
    setAssets(sessionData.assets || []);
    setReviews(sessionData.reviews || []);
    setSessionStatus(sessionData.session.status);
    setMissingRequired(sessionData.missing_required || 0);
    setActiveStepKey(sessionData.next_step_key || null);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [token]);

  const allSteps = useMemo(() => groups.flatMap((group) => group.steps), [groups]);

  const assetMap = useMemo(() => {
    const map: Record<string, Asset[]> = {};
    assets.forEach((asset) => {
      if (!map[asset.step_key]) {
        map[asset.step_key] = [];
      }
      map[asset.step_key].push(asset);
    });
    return map;
  }, [assets]);

  const reviewMap = useMemo(() => {
    const map: Record<string, Review> = {};
    reviews.forEach((review) => {
      map[review.step_key] = review;
    });
    return map;
  }, [reviews]);

  const requiredSteps = useMemo(() => allSteps.filter((step) => step.required), [allSteps]);

  const completedRequired = useMemo(
    () => requiredSteps.filter((step) => (assetMap[step.stepKey] || []).length >= step.minCount).length,
    [requiredSteps, assetMap]
  );

  const progress = requiredSteps.length ? Math.round((completedRequired / requiredSteps.length) * 100) : 0;

  const activeStepIndex = useMemo(
    () => (activeStepKey ? allSteps.findIndex((step) => step.stepKey === activeStepKey) : -1),
    [activeStepKey, allSteps]
  );

  const activeStep = activeStepIndex >= 0 ? allSteps[activeStepIndex] : null;

  const moveStep = (delta: number) => {
    if (!allSteps.length) return;
    const current = activeStepIndex >= 0 ? activeStepIndex : 0;
    const next = Math.max(0, Math.min(allSteps.length - 1, current + delta));
    setActiveStepKey(allSteps[next].stepKey);
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!activeStep || !event.target.files || event.target.files.length === 0) return;
    setUploading(true);
    setNotice('');
    try {
      const file = event.target.files[0];
      const formData = new FormData();
      formData.append('step_key', activeStep.stepKey);
      formData.append('file', file);
      const uploadResp = await fetch(`${API_BASE}/api/sessions/${token}/assets`, {
        method: 'POST',
        body: formData
      });
      if (!uploadResp.ok) {
        const error = await uploadResp.json();
        throw new Error(error.detail || 'Upload failed');
      }
      await load();
    } catch (error: any) {
      setNotice(error.message || 'Upload failed');
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  const handleSubmit = async () => {
    setNotice('');
    const resp = await fetch(`${API_BASE}/api/sessions/${token}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agree_documents_redaction: agreeDocs })
    });
    if (!resp.ok) {
      const error = await resp.json();
      setNotice(error.detail || 'Submit failed');
      return;
    }
    await load();
  };

  if (loading) return <main>Loading...</main>;

  return (
    <main>
      <div className="card">
        <h1>Seller Capture Session</h1>
        <p>Status: <span className="tag">{sessionStatus}</span></p>
        <div className="progress" style={{ marginBottom: '0.5rem' }}>
          <div style={{ width: `${progress}%` }} />
        </div>
        <p>{progress}% required steps completed ({completedRequired}/{requiredSteps.length}).</p>
        {notice && <div className="alert">{notice}</div>}
        {missingRequired > 0 && <p className="alert">Missing {missingRequired} required steps before submission.</p>}
      </div>

      <div className="card" style={{ marginTop: '1.5rem' }}>
        {activeStep ? (
          <>
            <h2>{activeStep.title}</h2>
            <p>{activeStep.description}</p>
            {reviewMap[activeStep.stepKey]?.decision === 'retake' && (
              <div className="alert">Retake requested: {reviewMap[activeStep.stepKey]?.comment || 'Please reshoot this step.'}</div>
            )}
            <p>Required: {activeStep.required ? 'Yes' : 'Optional'} • Min {activeStep.minCount}</p>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              disabled={uploading}
              onChange={handleUpload}
            />

            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap', marginTop: '1rem' }}>
              <button className="button secondary" type="button" onClick={() => moveStep(-1)} disabled={activeStepIndex <= 0 || uploading}>
                Back
              </button>
              <button className="button" type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                {(assetMap[activeStep.stepKey] || []).length > 0 ? 'Retake' : 'Take photo'}
              </button>
              {!activeStep.required && (
                <button className="button secondary" type="button" onClick={() => moveStep(1)} disabled={uploading || activeStepIndex >= allSteps.length - 1}>
                  Skip for now
                </button>
              )}
              <button className="button secondary" type="button" onClick={() => moveStep(1)} disabled={uploading || activeStepIndex >= allSteps.length - 1}>
                Next
              </button>
            </div>

            <div className="thumb-list" style={{ marginTop: '1rem' }}>
              {(assetMap[activeStep.stepKey] || []).map((asset) => (
                <img key={asset.id} src={toAbsoluteUrl(asset.preview_url)} className="thumb" alt={activeStep.title} />
              ))}
            </div>
          </>
        ) : (
          <p>All steps completed.</p>
        )}
      </div>

      <div className="card" style={{ marginTop: '1.5rem' }}>
        <h2>Submit session</h2>
        <label>
          <input
            type="checkbox"
            checked={agreeDocs}
            onChange={(event) => setAgreeDocs(event.target.checked)}
            style={{ width: 'auto', marginRight: '0.5rem' }}
          />
          I confirm documents are redacted (address/ID numbers) before upload.
        </label>
        <div style={{ marginTop: '1rem' }}>
          <button className="button" type="button" onClick={handleSubmit}>Submit for review</button>
        </div>
      </div>
    </main>
  );
}
