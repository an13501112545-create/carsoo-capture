'use client';

import { useEffect, useMemo, useState } from 'react';
import { resolvePreviewUrl } from '../../../lib/preview-url';

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
  preview_url?: string;
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
  const [missingRequired, setMissingRequired] = useState<number>(0);
  const [activeStep, setActiveStep] = useState<Step | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [uploading, setUploading] = useState<boolean>(false);
  const [notice, setNotice] = useState<string>('');
  const [agreeDocs, setAgreeDocs] = useState<boolean>(false);

  useEffect(() => {
    const load = async () => {
      const stepsResp = await fetch(`${API_BASE}/api/steps`);
      const stepsData = await stepsResp.json();
      const sessionResp = await fetch(`${API_BASE}/api/sessions/${token}`);
      const sessionData = await sessionResp.json();
      setGroups(stepsData);
      setAssets(sessionData.assets || []);
      setReviews(sessionData.reviews || []);
      setSessionStatus(sessionData.session.status);
      setMissingRequired(sessionData.missing_required || 0);
      setLoading(false);
    };
    load();
  }, [token]);

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

  const requiredSteps = useMemo(() => {
    return groups.flatMap((group) => group.steps.filter((step) => step.required));
  }, [groups]);

  const completedRequired = useMemo(() => {
    return requiredSteps.filter((step) => (assetMap[step.stepKey] || []).length >= step.minCount)
      .length;
  }, [requiredSteps, assetMap]);

  const totalRequired = requiredSteps.length;
  const progress = totalRequired ? Math.round((completedRequired / totalRequired) * 100) : 0;

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>, step: Step) => {
    if (!event.target.files || event.target.files.length === 0) return;
    setUploading(true);
    setNotice('');
    try {
      const file = event.target.files[0];
      const presignResp = await fetch(`${API_BASE}/api/sessions/${token}/presign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, mime_type: file.type })
      });
      const presignData = await presignResp.json();
      await fetch(presignData.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file
      });
      const confirmResp = await fetch(`${API_BASE}/api/sessions/${token}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step_key: step.stepKey, s3_key: presignData.s3Key, mime_type: file.type })
      });
      if (!confirmResp.ok) {
        const error = await confirmResp.json();
        throw new Error(error.detail || 'Upload failed');
      }
      const confirmData = await confirmResp.json();
      setAssets((prev) => [...prev, { id: confirmData.id, step_key: step.stepKey, preview_url: confirmData.preview_url }]);
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
  };

  if (loading) {
    return <main>Loading...</main>;
  }

  return (
    <main>
      <div className="card">
        <h1>Seller Capture Session</h1>
        <p>Status: <span className="tag">{sessionStatus}</span></p>
        <div className="progress" style={{ marginBottom: '0.5rem' }}>
          <div style={{ width: `${progress}%` }} />
        </div>
        <p>{progress}% required steps completed ({completedRequired}/{totalRequired}).</p>
        {notice && <div className="alert">{notice}</div>}
        {missingRequired > 0 && (
          <p className="alert">Missing {missingRequired} required steps before submission.</p>
        )}
      </div>

      <div className="grid two" style={{ marginTop: '1.5rem' }}>
        <div className="card">
          <h2>Steps</h2>
          <div className="step-list">
            {groups.map((group) => (
              <div key={group.group}>
                <h3>{group.group}</h3>
                <div className="step-list">
                  {group.steps.map((step) => {
                    const count = (assetMap[step.stepKey] || []).length;
                    const review = reviewMap[step.stepKey];
                    return (
                      <button
                        key={step.stepKey}
                        className="button secondary"
                        type="button"
                        onClick={() => setActiveStep(step)}
                      >
                        {step.title} ({count}/{step.minCount})
                        {review?.decision === 'retake' ? ' • Retake' : ''}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          {activeStep ? (
            <div>
              <h2>{activeStep.title}</h2>
              <p>{activeStep.description}</p>
              {reviewMap[activeStep.stepKey]?.decision === 'retake' && (
                <div className="alert">
                  Retake requested: {reviewMap[activeStep.stepKey]?.comment || 'Please reshoot this step.'}
                </div>
              )}
              <p>Required: {activeStep.required ? 'Yes' : 'Optional'} • Min {activeStep.minCount}</p>
              <input
                type="file"
                accept={activeStep.mode === 'doc' ? 'image/*,application/pdf' : 'image/*'}
                capture="environment"
                disabled={uploading}
                onChange={(event) => handleUpload(event, activeStep)}
              />
              <div className="thumb-list" style={{ marginTop: '1rem' }}>
                {(assetMap[activeStep.stepKey] || []).map((asset) => (
                  <img key={asset.id} src={resolvePreviewUrl(asset.preview_url)} className="thumb" alt={activeStep.title} />
                ))}
              </div>
            </div>
          ) : (
            <p>Select a step to begin capturing.</p>
          )}
        </div>
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
          <button className="button" type="button" onClick={handleSubmit}>
            Submit for review
          </button>
        </div>
      </div>
    </main>
  );
}
