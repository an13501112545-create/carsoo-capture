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
  const [activeStepIndex, setActiveStepIndex] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [uploading, setUploading] = useState<boolean>(false);
  const [notice, setNotice] = useState<string>('');
  const [agreeDocs, setAgreeDocs] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const orderedSteps = useMemo(() => {
    const all = groups.flatMap((group) => group.steps);
    const required = all.filter((step) => step.required);
    const optional = all.filter((step) => !step.required);
    return [...required, ...optional];
  }, [groups]);

  const activeStep = orderedSteps[activeStepIndex] || null;

  const refreshSession = async () => {
    const sessionResp = await fetch(`${API_BASE}/api/sessions/${token}`);
    const sessionData = await sessionResp.json();
    setAssets(sessionData.assets || []);
    setReviews(sessionData.reviews || []);
    setSessionStatus(sessionData.session.status);
    setMissingRequired(sessionData.missing_required || 0);
    if (sessionData.next_step_key && orderedSteps.length > 0) {
      const idx = orderedSteps.findIndex((step) => step.stepKey === sessionData.next_step_key);
      if (idx >= 0) {
        setActiveStepIndex(idx);
      }
    }
  };

  useEffect(() => {
    const load = async () => {
      const stepsResp = await fetch(`${API_BASE}/api/steps`);
      const stepsData = await stepsResp.json();
      setGroups(stepsData);
      const sessionResp = await fetch(`${API_BASE}/api/sessions/${token}`);
      const sessionData = await sessionResp.json();
      const loadedSteps = [
        ...stepsData.flatMap((group: StepGroup) => group.steps.filter((step: Step) => step.required)),
        ...stepsData.flatMap((group: StepGroup) => group.steps.filter((step: Step) => !step.required))
      ];
      setAssets(sessionData.assets || []);
      setReviews(sessionData.reviews || []);
      setSessionStatus(sessionData.session.status);
      setMissingRequired(sessionData.missing_required || 0);
      const idx = loadedSteps.findIndex((step: Step) => step.stepKey === sessionData.next_step_key);
      setActiveStepIndex(idx >= 0 ? idx : 0);
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
      const formData = new FormData();
      formData.append('step_key', step.stepKey);
      formData.append('file', file);
      const uploadResp = await fetch(`${API_BASE}/api/sessions/${token}/assets`, {
        method: 'POST',
        body: formData
      });
      if (!uploadResp.ok) {
        const error = await uploadResp.json();
        throw new Error(error.detail || 'Upload failed');
      }
      await refreshSession();
      setActiveStepIndex((prev) => Math.min(prev + 1, Math.max(0, orderedSteps.length - 1)));
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

  const handleNext = () => {
    setActiveStepIndex((prev) => Math.min(prev + 1, Math.max(0, orderedSteps.length - 1)));
  };

  const handleBack = () => {
    setActiveStepIndex((prev) => Math.max(prev - 1, 0));
  };

  const triggerTakePhoto = () => {
    fileInputRef.current?.click();
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
                        onClick={() => {
                          const idx = orderedSteps.findIndex((candidate) => candidate.stepKey === step.stepKey);
                          if (idx >= 0) setActiveStepIndex(idx);
                        }}
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
                ref={fileInputRef}
                type="file"
                style={{ display: 'none' }}
                accept={activeStep.mode === 'doc' ? 'image/*,application/pdf' : 'image/*'}
                capture="environment"
                disabled={uploading}
                onChange={(event) => handleUpload(event, activeStep)}
              />
              <div className="grid two" style={{ marginTop: '1rem' }}>
                <button className="button" type="button" onClick={handleBack} disabled={activeStepIndex === 0 || uploading}>
                  Back
                </button>
                <button className="button secondary" type="button" onClick={handleNext} disabled={activeStepIndex >= orderedSteps.length - 1 || uploading}>
                  Next
                </button>
              </div>
              <div className="grid two" style={{ marginTop: '0.5rem' }}>
                <button className="button" type="button" onClick={triggerTakePhoto} disabled={uploading}>
                  {(assetMap[activeStep.stepKey] || []).length > 0 ? 'Retake' : 'Take photo'}
                </button>
                {!activeStep.required && (
                  <button className="button secondary" type="button" onClick={handleNext} disabled={uploading}>
                    Skip for now
                  </button>
                )}
              </div>
              <div className="thumb-list" style={{ marginTop: '1rem' }}>
                {(assetMap[activeStep.stepKey] || []).map((asset) => (
                  <img key={asset.id} src={asset.file_url} className="thumb" alt={activeStep.title} />
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
