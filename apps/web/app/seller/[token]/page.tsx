'use client';

import { useEffect, useMemo, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';

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

interface Asset {
  id: number;
  step_key: string;
  preview_url?: string;
}

export default function SellerCapturePage({ params }: { params: { token: string } }) {
  const { token } = params;
  const [groups, setGroups] = useState<StepGroup[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [sessionStatus, setSessionStatus] = useState('draft');
  const [activeStepKey, setActiveStepKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState('');
  const [agreeDocs, setAgreeDocs] = useState(false);

  const allSteps = useMemo(() => groups.flatMap((g) => g.steps), [groups]);
  const activeIndex = useMemo(() => allSteps.findIndex((step) => step.stepKey === activeStepKey), [allSteps, activeStepKey]);
  const activeStep = activeIndex >= 0 ? allSteps[activeIndex] : null;

  const assetsByStep = useMemo(() => {
    const map: Record<string, Asset[]> = {};
    assets.forEach((asset) => {
      map[asset.step_key] = map[asset.step_key] || [];
      map[asset.step_key].push(asset);
    });
    return map;
  }, [assets]);

  useEffect(() => {
    const load = async () => {
      const [stepsResp, sessionResp] = await Promise.all([
        fetch(`${API_BASE}/api/steps`),
        fetch(`${API_BASE}/api/sessions/${token}`),
      ]);
      const stepsData = await stepsResp.json();
      const sessionData = await sessionResp.json();

      const steps = stepsData as StepGroup[];
      const flat = steps.flatMap((g) => g.steps);
      setGroups(steps);
      setAssets(sessionData.assets || []);
      setSessionStatus(sessionData.session?.status || 'draft');
      setActiveStepKey(sessionData.next_step_key || flat[0]?.stepKey || null);
      setLoading(false);
    };

    load();
  }, [token]);

  const moveTo = (index: number) => {
    const bounded = Math.max(0, Math.min(index, allSteps.length - 1));
    setActiveStepKey(allSteps[bounded]?.stepKey ?? null);
  };

  const onUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files?.length || !activeStep) return;
    const file = event.target.files[0];
    setUploading(true);
    setNotice('');

    try {
      const body = new FormData();
      body.append('step_key', activeStep.stepKey);
      body.append('file', file);

      const resp = await fetch(`${API_BASE}/api/sessions/${token}/assets`, {
        method: 'POST',
        body,
      });

      const payload = await resp.json();
      if (!resp.ok) {
        throw new Error(payload.detail || 'Upload failed');
      }

      setAssets((prev) => [...prev, { id: payload.id, step_key: activeStep.stepKey, preview_url: payload.preview_url }]);
      if (payload.next_step_key) {
        setActiveStepKey(payload.next_step_key);
      }
    } catch (error: any) {
      setNotice(error.message);
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  const onSubmit = async () => {
    const resp = await fetch(`${API_BASE}/api/sessions/${token}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agree_documents_redaction: agreeDocs }),
    });
    const payload = await resp.json();
    if (!resp.ok) {
      setNotice(payload.detail || 'Submit failed');
      return;
    }
    setSessionStatus('submitted');
  };

  if (loading) return <main>Loading...</main>;
  if (!activeStep) return <main>No steps available.</main>;

  const canSkip = !activeStep.required;
  const stepAssets = assetsByStep[activeStep.stepKey] || [];

  return (
    <main>
      <div className="card">
        <h1>Seller Capture Wizard</h1>
        <p>Status: <span className="tag">{sessionStatus}</span></p>
        <p>Step {activeIndex + 1} of {allSteps.length}</p>
        {notice && <div className="alert">{notice}</div>}
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <h2>{activeStep.title}</h2>
        <p>{activeStep.description}</p>
        <p>{activeStep.required ? 'Required step' : 'Optional step'}</p>

        <input
          type="file"
          accept="image/*"
          capture="environment"
          disabled={uploading}
          onChange={onUpload}
        />

        <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button className="button secondary" type="button" disabled={activeIndex <= 0} onClick={() => moveTo(activeIndex - 1)}>Back</button>
          <button className="button secondary" type="button" disabled={activeIndex >= allSteps.length - 1} onClick={() => moveTo(activeIndex + 1)}>Next</button>
          <button className="button secondary" type="button" disabled={!canSkip} onClick={() => moveTo(activeIndex + 1)}>Skip for now</button>
          <label className="button" style={{ margin: 0 }}>
            {stepAssets.length ? 'Retake' : 'Take photo'}
            <input type="file" accept="image/*" capture="environment" disabled={uploading} onChange={onUpload} style={{ display: 'none' }} />
          </label>
        </div>

        <div className="thumb-list" style={{ marginTop: '1rem' }}>
          {stepAssets.map((asset) => (
            <img key={asset.id} src={asset.preview_url} className="thumb" alt={activeStep.title} />
          ))}
        </div>
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
        <div style={{ marginTop: '0.75rem' }}>
          <button className="button" type="button" onClick={onSubmit}>Submit for review</button>
        </div>
      </div>
    </main>
  );
}
