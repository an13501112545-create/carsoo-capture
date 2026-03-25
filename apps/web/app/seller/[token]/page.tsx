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

interface ProgressSummary {
  required_total: number;
  required_complete: number;
  required_remaining: number;
  optional_total: number;
  optional_complete: number;
  optional_remaining: number;
}

export default function SellerCapturePage({ params }: { params: { token: string } }) {
  const { token } = params;
  const [steps, setSteps] = useState<Step[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [progress, setProgress] = useState<ProgressSummary | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>('draft');
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [uploading, setUploading] = useState<boolean>(false);
  const [notice, setNotice] = useState<string>('');
  const [agreeDocs, setAgreeDocs] = useState<boolean>(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [capturedStepKey, setCapturedStepKey] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const load = async () => {
      const stepsResp = await fetch(`${API_BASE}/api/steps`);
      const stepsData: StepGroup[] = await stepsResp.json();
      const flatSteps = stepsData.flatMap((group) => group.steps);
      const sessionResp = await fetch(`${API_BASE}/api/sessions/${token}`);
      const sessionData = await sessionResp.json();

      setSteps(flatSteps);
      setAssets(sessionData.assets || []);
      setReviews(sessionData.reviews || []);
      setSessionStatus(sessionData.session.status);
      setProgress(sessionData.progress || null);

      const stored = localStorage.getItem(`capture-step-${token}`);
      const storedIndex = stored ? Number(stored) : NaN;
      const firstIncompleteRequired = flatSteps.findIndex((step) => {
        if (!step.required) return false;
        return !(sessionData.assets || []).some((asset: Asset) => asset.step_key === step.stepKey);
      });
      if (!Number.isNaN(storedIndex) && storedIndex >= 0 && storedIndex < flatSteps.length) {
        setActiveIndex(storedIndex);
      } else if (firstIncompleteRequired >= 0) {
        setActiveIndex(firstIncompleteRequired);
      }
      setLoading(false);
    };
    load();
  }, [token]);

  useEffect(() => {
    localStorage.setItem(`capture-step-${token}`, String(activeIndex));
  }, [activeIndex, token]);

  const activeStep = steps[activeIndex];

  const assetMap = useMemo(() => {
    const map: Record<string, Asset[]> = {};
    assets.forEach((asset) => {
      if (!map[asset.step_key]) map[asset.step_key] = [];
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

  const moveToNext = (preferRequired: boolean) => {
    if (!steps.length) return;
    if (preferRequired) {
      const nextRequired = steps.findIndex((step, idx) => idx > activeIndex && step.required);
      if (nextRequired >= 0) {
        setActiveIndex(nextRequired);
        return;
      }
    }
    setActiveIndex((prev) => Math.min(prev + 1, steps.length - 1));
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>, step: Step) => {
    if (!event.target.files || event.target.files.length === 0) return;
    setUploading(true);
    setNotice('');
    try {
      const file = event.target.files[0];
      setPreviewUrl(URL.createObjectURL(file));
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
      const alreadyComplete = (assetMap[step.stepKey] || []).length >= step.minCount;
      setAssets((prev) => [...prev, { id: confirmData.id, step_key: step.stepKey, file_url: confirmData.fileUrl }]);
      setCapturedStepKey(step.stepKey);
      setProgress((prev) => {
        if (!prev || alreadyComplete) return prev;
        if (!step.required) {
          return {
            ...prev,
            optional_complete: prev.optional_complete + 1,
            optional_remaining: Math.max(prev.optional_remaining - 1, 0)
          };
        }
        return {
          ...prev,
          required_complete: prev.required_complete + 1,
          required_remaining: Math.max(prev.required_remaining - 1, 0)
        };
      });
      if (step.required) {
        setTimeout(() => moveToNext(true), 900);
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

  if (loading || !activeStep) {
    return <main>Loading...</main>;
  }

  const stepAssets = assetMap[activeStep.stepKey] || [];
  const canSubmit = (progress?.required_remaining || 0) === 0;

  return (
    <main className="seller-mobile">
      <div className="card">
        <h1>Carsoo Photo Capture</h1>
        <p>Status: <span className="tag">{sessionStatus}</span></p>
        <div className="progress" style={{ marginBottom: '0.5rem' }}>
          <div style={{ width: `${progress ? Math.round((progress.required_complete / Math.max(progress.required_total, 1)) * 100) : 0}%` }} />
        </div>
        <p>
          Required complete: {progress?.required_complete || 0}/{progress?.required_total || 0} • Remaining: {progress?.required_remaining || 0}
        </p>
        <p>Optional remaining: {progress?.optional_remaining || 0}</p>
        {notice && <div className="alert">{notice}</div>}
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <p className="tag">Step {activeIndex + 1} of {steps.length}</p>
        <h2>{activeStep.title}</h2>
        <p>{activeStep.description}</p>
        <div className="example-box">Example placeholder</div>
        {reviewMap[activeStep.stepKey]?.decision === 'retake' && (
          <div className="alert">Retake requested: {reviewMap[activeStep.stepKey]?.comment || 'Please recapture this photo.'}</div>
        )}

        <input
          ref={fileRef}
          type="file"
          accept={activeStep.mode === 'doc' ? 'image/*,application/pdf' : 'image/*'}
          capture="environment"
          style={{ display: 'none' }}
          disabled={uploading}
          onChange={(event) => handleUpload(event, activeStep)}
        />
        <button className="button" type="button" disabled={uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? 'Uploading…' : 'Take photo'}
        </button>
        {!activeStep.required && (
          <button className="button secondary" type="button" onClick={() => moveToNext(false)} style={{ marginLeft: '0.5rem' }}>
            Skip for now
          </button>
        )}

        {(previewUrl || stepAssets.length > 0) && (
          <div style={{ marginTop: '1rem' }}>
            <img src={previewUrl || stepAssets[stepAssets.length - 1].file_url} className="preview-image" alt={activeStep.title} />
            <div style={{ marginTop: '0.75rem' }}>
              <button className="button secondary" type="button" onClick={() => fileRef.current?.click()}>
                Retake
              </button>
              <button className="button" type="button" onClick={() => moveToNext(false)} style={{ marginLeft: '0.5rem' }}>
                Next
              </button>
            </div>
          </div>
        )}

        {capturedStepKey === activeStep.stepKey && activeStep.required && <p>Uploaded. Moving to next required step…</p>}
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
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
          <button className="button" type="button" disabled={!canSubmit} onClick={handleSubmit}>
            Submit for review
          </button>
        </div>
        {!canSubmit && <p className="alert">Complete the core required photos before submitting.</p>}
      </div>
    </main>
  );
}
