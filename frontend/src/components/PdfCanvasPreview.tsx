import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type RenderTask
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { FileMusic, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfCanvasPreviewProps {
  url: string;
}

interface PdfPageSize {
  height: number;
  width: number;
}

export function PdfCanvasPreview({ url }: PdfCanvasPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [pageSizes, setPageSizes] = useState<PdfPageSize[]>([]);
  const [renderedPages, setRenderedPages] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => {
      setContainerWidth(Math.floor(container.getBoundingClientRect().width));
    };
    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadingTask = getDocument({
      url,
      useSystemFonts: true
    });

    setLoading(true);
    setError(null);
    setPageSizes([]);
    setRenderedPages(new Set());
    canvasRefs.current = [];

    const loadPdf = async () => {
      try {
        const pdf = await loadingTask.promise;
        const sizes = await Promise.all(
          Array.from({ length: pdf.numPages }, async (_, index) => {
            const page = await pdf.getPage(index + 1);
            const viewport = page.getViewport({ scale: 1 });
            return { width: viewport.width, height: viewport.height };
          })
        );

        if (!cancelled) {
          documentRef.current = pdf;
          setPageSizes(sizes);
        }
      } catch (loadError) {
        if (!cancelled) {
          setLoading(false);
          setError(
            loadError instanceof Error
              ? `PDF 预览失败：${loadError.message}`
              : "PDF 预览失败"
          );
        }
      }
    };

    void loadPdf();
    return () => {
      cancelled = true;
      documentRef.current = null;
      void loadingTask.destroy();
    };
  }, [url]);

  useEffect(() => {
    const pdf = documentRef.current;
    if (!pdf || !pageSizes.length || !containerWidth) return;

    let cancelled = false;
    const renderTasks: RenderTask[] = [];
    setLoading(true);
    setError(null);
    setRenderedPages(new Set());

    const renderPages = async () => {
      try {
        for (let index = 0; index < pageSizes.length; index += 1) {
          if (cancelled) return;

          const canvas = canvasRefs.current[index];
          if (!canvas) continue;

          const page = await pdf.getPage(index + 1);
          const baseViewport = page.getViewport({ scale: 1 });
          const cssScale = containerWidth / baseViewport.width;
          const outputScale = Math.min(window.devicePixelRatio || 1, 2);
          const viewport = page.getViewport({
            scale: cssScale * outputScale
          });

          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          canvas.style.width = `${Math.floor(baseViewport.width * cssScale)}px`;
          canvas.style.height = `${Math.floor(baseViewport.height * cssScale)}px`;
          canvas.removeAttribute("data-rendered");

          const renderTask = page.render({
            canvas,
            viewport,
            background: "#ffffff"
          });
          renderTasks.push(renderTask);
          await renderTask.promise;

          if (!cancelled) {
            canvas.dataset.rendered = "true";
            setRenderedPages((current) => new Set(current).add(index));
          }
        }

        if (!cancelled) setLoading(false);
      } catch (renderError) {
        if (!cancelled && (renderError as Error).name !== "RenderingCancelledException") {
          setLoading(false);
          setError(
            renderError instanceof Error
              ? `PDF 页面绘制失败：${renderError.message}`
              : "PDF 页面绘制失败"
          );
        }
      }
    };

    void renderPages();
    return () => {
      cancelled = true;
      renderTasks.forEach((task) => task.cancel());
    };
  }, [containerWidth, pageSizes]);

  return (
    <div
      className="pdf-canvas-preview"
      ref={containerRef}
      aria-label="原版式 CDEFGAB 标注 PDF"
    >
      {pageSizes.map((size, index) => (
        <div
          className="score-pdf-page"
          key={`${url}-${index}`}
          style={{ aspectRatio: `${size.width} / ${size.height}` }}
        >
          <canvas
            ref={(canvas) => {
              canvasRefs.current[index] = canvas;
            }}
            aria-label={`PDF 第 ${index + 1} 页`}
          />
          {!renderedPages.has(index) && (
            <div className="pdf-page-loading" aria-hidden="true">
              <LoaderCircle className="spin" size={24} />
            </div>
          )}
        </div>
      ))}

      {loading && !pageSizes.length && (
        <div className="score-empty pdf-loading">
          <LoaderCircle className="spin" size={30} />
          <strong>正在绘制 PDF</strong>
          <span>保留原始页面、字体尺寸、颜色与标注位置。</span>
        </div>
      )}

      {error && (
        <div className="score-empty score-error pdf-loading" role="alert">
          <FileMusic size={30} />
          <strong>PDF 预览失败</strong>
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
