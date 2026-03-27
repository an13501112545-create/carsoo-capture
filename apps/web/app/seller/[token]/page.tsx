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
  thumb_url?: string;
  preview_url?: string;
}

interface Review {
  step_key: string;
  decision: string;
  comment?: string;
}

const getAssetPreviewUrl = (asset: Asset) => {
  const previewPath = asset.preview_url || asset.thumb_url || '';
  if (!previewPath) return '';
  if (previewPath.startsWith('http://') || previewPath.startsWith('https://')) return previewPath;
  return `${API_BASE}${previewPath}`;
};

export default function SellerCapturePage({ params }: { params: { token: string } }) {
  const { token } = params;
  const [groups, setGroups] = useState<StepGroup[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [sessionStatus, setSessionStatus] = useState<string>('draft');
  const [missingRequired, setMissingRequired] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [uploading, setUploading] = useState<boolean>(false);
  const [notice, setNotice] = useState<string>('');
  const [agreeDocs, setAgreeDocs] = useState<boolean>(false);
  const [activeStepKey, setActiveStepKey] = useState<string | null>(null);

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
      setActiveStepKey(sessionData.next_step_key || null);
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

  const allSteps = useMemo(() => groups.flatMap((group) => group.steps), [groups]);

  const requiredSteps = useMemo(() => allSteps.filter((step) => step.required), [allSteps]);

  const completedRequired = useMemo(() => {
    return requiredSteps.filter((step) => (assetMap[step.stepKey] || []).length >= step.minCount)
      .length;
  }, [requiredSteps, assetMap]);

  const totalRequired = requiredSteps.length;
  const progress = totalRequired ? Math.round((completedRequired / totalRequired) * 100) : 0;
  const activeStep = useMemo(() => {
    if (!allSteps.length) return null;
    if (!activeStepKey) return null;
    return allSteps.find((step) => step.stepKey === activeStepKey) || null;
  }, [allSteps, activeStepKey]);

  const findNextStepKey = (fromStepKey?: string, direction: 1 | -1 = 1) => {
    if (!allSteps.length) return null;
    const requiredIncomplete = allSteps
      .filter((step) => step.required)
      .filter((step) => (assetMap[step.stepKey] || []).length < step.minCount);
    const optionalIncomplete = allSteps
      .filter((step) => !step.required)
      .filter((step) => (assetMap[step.stepKey] || []).length < step.minCount);
    const queue = [...requiredIncomplete, ...optionalIncomplete];
    if (!queue.length) return null;
    if (!fromStepKey) return queue[0].stepKey;
    const currentIndex = queue.findIndex((step) => step.stepKey === fromStepKey);
    if (currentIndex === -1) return queue[0].stepKey;
    const nextIndex = currentIndex + direction;
    return queue[nextIndex]?.stepKey || queue[currentIndex].stepKey;
  };

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
      setAssets((prev) => [...prev, { id: confirmData.id, step_key: step.stepKey, preview_url: confirmData.previewUrl }]);
      setActiveStepKey(findNextStepKey(step.stepKey, 1));
      const sessionResp = await fetch(`${API_BASE}/api/sessions/${token}`);
      if (sessionResp.ok) {
        const sessionData = await sessionResp.json();
        setMissingRequired(sessionData.missing_required || 0);
        setSessionStatus(sessionData.session.status);
      }
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
              <h2>{activeStep.title}</h2>
              <p>{activeStep.description}</p>
              {reviewMap[activeStep.stepKey]?.decision === 'retake' && (
                <div className="alert">
                  Retake requested: {reviewMap[activeStep.stepKey]?.comment || 'Please reshoot this step.'}
                </div>
              )}
              <p>Required: {activeStep.required ? 'Yes' : 'Optional'} • Min {activeStep.minCount}</p>
              <input
                id="seller-step-upload"
                type="file"
                accept="image/*"
                capture="environment"
                disabled={uploading}
                onChange={(event) => handleUpload(event, activeStep)}
                style={{ display: 'none' }}
              />
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button className="button secondary" type="button" onClick={() => setActiveStepKey(findNextStepKey(activeStep.stepKey, -1))}>
                  Back
                </button>
                <button className="button secondary" type="button" onClick={() => setActiveStepKey(findNextStepKey(activeStep.stepKey, 1))}>
                  Next
                </button>
                <button className="button" type="button" disabled={uploading} onClick={() => document.getElementById('seller-step-upload')?.click()}>
                  {(assetMap[activeStep.stepKey] || []).length > 0 ? 'Retake' : 'Take photo'}
                </button>
                {!activeStep.required && (
                  <button className="button secondary" type="button" onClick={() => setActiveStepKey(findNextStepKey(activeStep.stepKey, 1))}>
                    Skip for now
                  </button>
                )}
              </div>
              <div className="thumb-list" style={{ marginTop: '1rem' }}>
                {(assetMap[activeStep.stepKey] || []).map((asset) => {
                  const previewUrl = getAssetPreviewUrl(asset);
                  return previewUrl ? <img key={asset.id} src={previewUrl} className="thumb" alt={activeStep.title} /> : null;
                })}
              </div>
            </div>
          ) : (
            <p>All steps complete.</p>
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
