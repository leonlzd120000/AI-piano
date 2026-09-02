import {
  Check,
  KeyRound,
  LoaderCircle,
  Save,
  Sparkles,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { configureModel, testModel } from "../api";
import type { ModelCatalog } from "../types";

interface ModelManagerProps {
  catalog: ModelCatalog;
  onClose: () => void;
  onChanged: (catalog: ModelCatalog) => void;
}

export function ModelManager({
  catalog,
  onClose,
  onChanged
}: ModelManagerProps) {
  const [selectedModelId, setSelectedModelId] = useState(catalog.active_model_id);
  const [apiKey, setApiKey] = useState("");
  const [prompt, setPrompt] = useState("请用一句话说明如何练习钢琴中的音符识别。");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedModel = useMemo(
    () => catalog.models.find((model) => model.id === selectedModelId),
    [catalog.models, selectedModelId]
  );

  useEffect(() => {
    setSelectedModelId(catalog.active_model_id);
  }, [catalog.active_model_id]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const nextCatalog = await configureModel(selectedModelId, apiKey);
      onChanged(nextCatalog);
      setMessage("模型配置已保存");
      setApiKey("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "模型配置失败");
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setError(null);
    setMessage(null);
    try {
      const result = await testModel(selectedModelId, prompt, apiKey);
      setMessage(result.text);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "模型测试失败");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="model-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-manager-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="model-modal-header">
          <div>
            <span className="eyebrow">MODEL RUNTIME</span>
            <h2 id="model-manager-title">模型管理</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭模型管理">
            <X size={17} />
          </button>
        </header>

        <div className="model-modal-body">
          <label className="model-field">
            <span>当前大模型</span>
            <select
              aria-label="选择大模型"
              value={selectedModelId}
              onChange={(event) => {
                setSelectedModelId(event.target.value);
                setMessage(null);
                setError(null);
              }}
            >
              {catalog.models.map((model) => (
                <option
                  value={model.id}
                  disabled={!model.configured && model.provider === "google-ai-studio"}
                  key={model.id}
                >
                  {model.provider_label} · {model.name}
                  {model.status === "preview" ? " · Preview" : ""}
                </option>
              ))}
            </select>
          </label>

          <div className="model-selected-info">
            <Sparkles size={16} />
            <div>
              <strong>{selectedModel?.name ?? "未选择模型"}</strong>
              <span>{selectedModel?.description}</span>
            </div>
          </div>

          <label className="model-field">
            <span>
              <KeyRound size={13} />
              Google AI Studio API Key
            </span>
            <input
              aria-label="Google AI Studio API Key"
              type="password"
              value={apiKey}
              placeholder={
                catalog.google_configured
                  ? "已通过环境变量或运行时配置"
                  : "粘贴 Gemini API Key"
              }
              onChange={(event) => setApiKey(event.target.value)}
            />
            <small>密钥仅提交给本地后端，不会返回到页面或写入仓库。</small>
          </label>

          <div className="model-test-section">
            <label className="model-field">
              <span>模型测试提示词</span>
              <textarea
                aria-label="模型测试提示词"
                rows={3}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            <button
              className="button button-secondary model-test-button"
              type="button"
              disabled={testing}
              onClick={() => void test()}
            >
              {testing ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
              测试模型
            </button>
          </div>

          {message ? (
            <div className="model-feedback is-success" role="status">
              <Check size={15} />
              <span>{message}</span>
            </div>
          ) : null}
          {error ? (
            <div className="model-feedback is-error" role="alert">
              <X size={15} />
              <span>{error}</span>
            </div>
          ) : null}
        </div>

        <footer className="model-modal-footer">
          <span>
            {catalog.google_configured ? "Google AI Studio 已配置" : "尚未配置 Google API Key"}
          </span>
          <button
            className="button button-primary"
            type="button"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
            保存并启用
          </button>
        </footer>
      </section>
    </div>
  );
}
