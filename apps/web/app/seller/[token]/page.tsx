'use client';

import { useEffect, useMemo, useState } from 'react';

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
  file_url?: string;
  fileUrl?: string;
  preview_url?: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  size_bytes?: number;
  sizeBytes?: number;
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
  const [stepOrder, setStepOrder] = useState<Step[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(0);
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
      const orderedSteps: Step[] = stepsData.flatMap((group: StepGroup) => group.steps);
      const sessionNextStep = sessionData.next_step_key || sessionData.session?.next_step_key;
      const initialIndex =
        orderedSteps.findIndex((step) => step.stepKey === sessionNextStep) >= 0
          ? orderedSteps.findIndex((step) => step.stepKey === sessionNextStep)
          : 0;
      setGroups(stepsData);
      setStepOrder(orderedSteps);
      setCurrentStepIndex(initialIndex);
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
  const activeStep = stepOrder[currentStepIndex] || null;

  const getStepIndex = (stepKey?: string) => {
    if (!stepKey) return -1;
    return stepOrder.findIndex((step) => step.stepKey === stepKey);
  };

  const getAssetUrl = (asset: Asset) =>
    asset.preview_url || asset.previewUrl || asset.file_url || asset.fileUrl || '';

  const refreshSession = async () => {
    const sessionResp = await fetch(`${API_BASE}/api/sessions/${token}`);
    if (!sessionResp.ok) return;
    const sessionData = await sessionResp.json();
    setAssets(sessionData.assets || []);
    setReviews(sessionData.reviews || []);
    setSessionStatus(sessionData.session.status);
    setMissingRequired(sessionData.missing_required || 0);
    const nextStepIndex = getStepIndex(sessionData.next_step_key || sessionData.session?.next_step_key);
    if (nextStepIndex >= 0) {
      setCurrentStepIndex(nextStepIndex);
    }
  };

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
      const uploadData = await uploadResp.json();
      setAssets((prev) => [
        ...prev,
        {
          id: uploadData.id,
          step_key: step.stepKey,
          file_url: uploadData.fileUrl,
          preview_url: uploadData.previewUrl,
          width: uploadData.width,
          height: uploadData.height,
          sizeBytes: uploadData.sizeBytes
        }
      ]);
      const nextStepIndex = getStepIndex(uploadData.next_step_key || uploadData.nextStepKey);
      if (nextStepIndex >= 0) {
        setCurrentStepIndex(nextStepIndex);
      } else {
        setCurrentStepIndex((prevIndex) => Math.min(prevIndex + 1, Math.max(stepOrder.length - 1, 0)));
      }
      await refreshSession();
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

      <div style={{ marginTop: '1.5rem' }}>
      <div className="card">
          {activeStep ? (
            <div>
              <p>
                Step {currentStepIndex + 1} of {stepOrder.length}
              </p>
              <h2>{activeStep.title}</h2>
              <p>{activeStep.description}</p>
              <p><strong>Example:</strong> {activeStep.example}</p>
              {reviewMap[activeStep.stepKey]?.decision === 'retake' && (
                <div className="alert">
                  Retake requested: {reviewMap[activeStep.stepKey]?.comment || 'Please reshoot this step.'}
                </div>
              )}
              <p>Required: {activeStep.required ? 'Yes' : 'Optional'} • Min {activeStep.minCount}</p>
              <input
                id="seller-upload-input"
                type="file"
                accept="image/*"
                capture="environment"
                disabled={uploading}
                onChange={(event) => handleUpload(event, activeStep)}
                style={{ display: 'none' }}
              />
              <div className="grid two" style={{ marginTop: '1rem' }}>
                <button
                  className="button secondary"
                  type="button"
                  disabled={currentStepIndex === 0}
                  onClick={() => setCurrentStepIndex((prev) => Math.max(prev - 1, 0))}
                >
                  Back
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={currentStepIndex >= stepOrder.length - 1}
                  onClick={() => setCurrentStepIndex((prev) => Math.min(prev + 1, stepOrder.length - 1))}
                >
                  Next
                </button>
              </div>
              <div className="grid two" style={{ marginTop: '0.75rem' }}>
                <button className="button" type="button" disabled={uploading} onClick={() => document.getElementById('seller-upload-input')?.click()}>
                  {(assetMap[activeStep.stepKey] || []).length > 0 ? 'Retake photo' : 'Take photo'}
                </button>
                {!activeStep.required && (
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => setCurrentStepIndex((prev) => Math.min(prev + 1, stepOrder.length - 1))}
                  >
                    Skip for now
                  </button>
                )}
              </div>
              <div className="thumb-list" style={{ marginTop: '1rem' }}>
                {(assetMap[activeStep.stepKey] || []).map((asset) => (
                  <img key={asset.id} src={getAssetUrl(asset)} className="thumb" alt={activeStep.title} />
                ))}
              </div>
            </div>
          ) : (
            <p>No active step available.</p>
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
