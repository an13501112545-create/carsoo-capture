'use client';

import { useEffect, useMemo, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';

interface Step {
  stepKey: string;
  title: string;
  description: string;
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
  thumb_url?: string | null;
}

interface Review {
  step_key: string;
  decision: string;
  comment?: string;
}

export default function SellerCapturePage({ params }: { params: { token: string } }) {
  const { token } = params;
  const [groups, setGroups] = useState<StepGroup[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [sessionStatus, setSessionStatus] = useState<string>('draft');
  const [activeStepKey, setActiveStepKey] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [uploading, setUploading] = useState<boolean>(false);
  const [notice, setNotice] = useState<string>('');
  const [agreeDocs, setAgreeDocs] = useState<boolean>(false);

  const steps = useMemo(() => groups.flatMap((group) => group.steps), [groups]);

  const stepMap = useMemo(() => {
    const map: Record<string, Step> = {};
    steps.forEach((step) => {
      map[step.stepKey] = step;
    });
    return map;
  }, [steps]);

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

  useEffect(() => {
    const load = async () => {
      const [stepsResp, sessionResp] = await Promise.all([
        fetch(`${API_BASE}/api/steps`),
        fetch(`${API_BASE}/api/sessions/${token}`)
      ]);
      const stepsData = await stepsResp.json();
      const sessionData = await sessionResp.json();
      setGroups(stepsData);
      setAssets(sessionData.assets || []);
      setReviews(sessionData.reviews || []);
      setSessionStatus(sessionData.session.status || 'draft');
      setActiveStepKey(sessionData.next_step_key || null);
      setLoading(false);
    };

    load();
  }, [token]);

  const activeStep = activeStepKey ? stepMap[activeStepKey] : null;

  const requiredSteps = useMemo(() => steps.filter((step) => step.required), [steps]);
  const completedRequired = useMemo(
    () => requiredSteps.filter((step) => (assetMap[step.stepKey] || []).length >= step.minCount).length,
    [requiredSteps, assetMap]
  );
  const totalRequired = requiredSteps.length;
  const progress = totalRequired ? Math.round((completedRequired / totalRequired) * 100) : 0;

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!activeStep || !event.target.files || event.target.files.length === 0) return;

    const file = event.target.files[0];
    setUploading(true);
    setNotice('');

    try {
      const formData = new FormData();
      formData.append('step_key', activeStep.stepKey);
      formData.append('file', file);

      const resp = await fetch(`${API_BASE}/api/sessions/${token}/assets`, {
        method: 'POST',
        body: formData
      });

      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.detail || 'Upload failed');
      }

      setAssets((prev) => [
        ...prev,
        {
          id: data.id,
          step_key: activeStep.stepKey,
          file_url: data.file_url,
          thumb_url: data.preview_url
        }
      ]);
      setActiveStepKey(data.next_step_key || null);
    } catch (error: any) {
      setNotice(error.message);
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
    setSessionStatus('submitted');
    setActiveStepKey(null);
  };

  if (loading) return <main>Loading...</main>;

  return (
    <main>
      <div className="card">
        <h1>Seller Capture Session</h1>
        <p>
          Status: <span className="tag">{sessionStatus}</span>
        </p>
        <div className="progress" style={{ marginBottom: '0.5rem' }}>
          <div style={{ width: `${progress}%` }} />
        </div>
        <p>
          {progress}% complete ({completedRequired}/{totalRequired} required steps)
        </p>
        {notice && <div className="alert">{notice}</div>}
      </div>

      <div className="card" style={{ marginTop: '1.5rem' }}>
        {activeStep ? (
          <>
            <h2>Current step: {activeStep.title}</h2>
            <p>{activeStep.description}</p>
            {reviewMap[activeStep.stepKey]?.decision === 'retake' && (
              <div className="alert">
                Retake requested: {reviewMap[activeStep.stepKey]?.comment || 'Please reshoot this step.'}
              </div>
            )}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              disabled={uploading}
              onChange={handleUpload}
            />
            <div className="thumb-list" style={{ marginTop: '1rem' }}>
              {(assetMap[activeStep.stepKey] || []).map((asset) => (
                <img
                  key={asset.id}
                  src={asset.thumb_url || asset.file_url}
                  className="thumb"
                  alt={activeStep.title}
                />
              ))}
            </div>
          </>
        ) : (
          <>
            <h2>All required capture steps are complete.</h2>
            <p>You can now submit for review.</p>
          </>
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
          <button className="button" type="button" onClick={handleSubmit} disabled={sessionStatus === 'submitted'}>
            Submit for review
          </button>
        </div>
      </div>
    </main>
  );
}
