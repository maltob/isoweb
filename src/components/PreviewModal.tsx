import React, { useEffect, useState } from 'react';
import { Binary, Download, Eye, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { VNode } from '../lib/types';
import { formatBytes, getFileCategory } from '../lib/utils';

interface PreviewModalProps {
  node: VNode;
  getFileBytes: (node: VNode) => Promise<Uint8Array>;
  onClose: () => void;
  onDownload: (node: VNode) => void;
}

export const PreviewModal: React.FC<PreviewModalProps> = ({
  node,
  getFileBytes,
  onClose,
  onDownload,
}) => {
  const [activeTab, setActiveTab] = useState<'preview' | 'hex'>('preview');
  const [data, setData] = useState<Uint8Array | null>(null);
  const [loading, setLoading] = useState(true);
  const [hexPage, setHexPage] = useState(0);

  const PAGE_SIZE = 512; // 512 bytes (1 sector) per page for hex view

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getFileBytes(node)
      .then((bytes) => {
        if (!cancelled) {
          setData(bytes);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error('Failed to load file bytes:', err);
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [node, getFileBytes]);

  const cat = getFileCategory(node.name, false);

  const renderTextPreview = () => {
    if (!data) return null;
    try {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(data.subarray(0, 100000));
      const lines = text.split('\n');

      return (
        <div className="font-mono text-xs text-slate-200 overflow-auto max-h-[60vh] p-4 bg-slate-950 rounded-lg border border-slate-800">
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((line, idx) => (
                <tr key={idx} className="hover:bg-slate-900/60">
                  <td className="w-10 pr-4 text-right text-slate-400 select-none border-r border-slate-800/80">
                    {idx + 1}
                  </td>
                  <td className="pl-4 whitespace-pre-wrap break-all">{line}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.length > 100000 && (
            <p className="mt-4 text-center text-amber-400 text-xs">
              Preview truncated (showing first 100 KB of {formatBytes(data.length)})
            </p>
          )}
        </div>
      );
    } catch {
      return (
        <div className="p-8 text-center text-slate-400 text-xs">
          Unable to decode text content. Try Hex Inspector tab.
        </div>
      );
    }
  };

  const renderImagePreview = () => {
    if (!data) return null;
    const blob = new Blob([data]);
    const url = URL.createObjectURL(blob);

    return (
      <div className="flex flex-col items-center justify-center p-6 bg-slate-950 rounded-lg border border-slate-800">
        <img
          src={url}
          alt={node.name}
          className="max-h-[50vh] max-w-full object-contain rounded shadow"
        />
        <p className="mt-3 text-xs text-slate-400">{formatBytes(data.length)}</p>
      </div>
    );
  };

  const renderHexInspector = () => {
    if (!data) return null;
    const totalPages = Math.max(1, Math.ceil(data.length / PAGE_SIZE));
    const start = hexPage * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, data.length);
    const pageBytes = data.subarray(start, end);

    const rows: { offset: number; hex: string[]; ascii: string }[] = [];

    for (let i = 0; i < pageBytes.length; i += 16) {
      const rowBytes = pageBytes.subarray(i, i + 16);
      const hex: string[] = [];
      let ascii = '';

      for (let j = 0; j < 16; j++) {
        if (j < rowBytes.length) {
          const b = rowBytes[j];
          hex.push(b.toString(16).padStart(2, '0').toUpperCase());
          ascii += b >= 32 && b <= 126 ? String.fromCharCode(b) : '·';
        } else {
          hex.push('  ');
          ascii += ' ';
        }
      }

      rows.push({
        offset: start + i,
        hex,
        ascii,
      });
    }

    return (
      <div className="flex flex-col gap-3">
        {/* Pagination Bar */}
        <div className="flex items-center justify-between bg-slate-950 px-3 py-2 rounded-md border border-slate-800 text-xs">
          <div className="text-slate-400">
            Offset: <span className="font-mono text-sky-400">0x{start.toString(16).toUpperCase()}</span> -{' '}
            <span className="font-mono text-sky-400">0x{(end - 1).toString(16).toUpperCase()}</span> of{' '}
            <span className="font-mono text-slate-300">{formatBytes(data.length)}</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setHexPage((p) => Math.max(0, p - 1))}
              disabled={hexPage === 0}
              className="p-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-slate-800 text-slate-300"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-slate-400 font-mono">
              Sector {hexPage + 1} / {totalPages}
            </span>
            <button
              onClick={() => setHexPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={hexPage >= totalPages - 1}
              className="p-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-slate-800 text-slate-300"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Hex Table */}
        <div className="font-mono text-[11px] leading-tight text-slate-300 overflow-auto max-h-[50vh] p-3 bg-slate-950 rounded-lg border border-slate-800">
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-slate-400 border-b border-slate-800 pb-1">
                <th className="text-left w-20 pr-3 pb-1">OFFSET</th>
                <th className="text-left pb-1 font-normal">
                  00 01 02 03 04 05 06 07  08 09 0A 0B 0C 0D 0E 0F
                </th>
                <th className="text-left pl-4 pb-1">ASCII</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.offset} className="hover:bg-slate-900/60">
                  <td className="text-slate-400 pr-3 select-none">
                    {row.offset.toString(16).padStart(8, '0').toUpperCase()}
                  </td>
                  <td className="tracking-wide">
                    <span className="text-slate-300">{row.hex.slice(0, 8).join(' ')}</span>
                    <span className="mx-2 text-slate-600">|</span>
                    <span className="text-slate-300">{row.hex.slice(8, 16).join(' ')}</span>
                  </td>
                  <td className="pl-4 text-emerald-400/90 whitespace-pre">{row.ascii}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between bg-slate-900/80">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-white truncate">{node.name}</h2>
            <span className="text-xs text-slate-400 font-mono">({formatBytes(node.size)})</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onDownload(node)}
              className="flex items-center gap-1.5 px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded border border-slate-700 transition cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-sky-400" />
              <span>Download</span>
            </button>
            <button
              onClick={onClose}
              className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tab Controls */}
        <div className="flex items-center gap-4 px-5 border-b border-slate-800 bg-slate-950/40 text-xs">
          <button
            onClick={() => setActiveTab('preview')}
            className={`flex items-center gap-1.5 py-2.5 border-b-2 font-medium transition cursor-pointer ${
              activeTab === 'preview'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            <span>Viewer Preview</span>
          </button>
          <button
            onClick={() => setActiveTab('hex')}
            className={`flex items-center gap-1.5 py-2.5 border-b-2 font-medium transition cursor-pointer ${
              activeTab === 'hex'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Binary className="w-3.5 h-3.5" />
            <span>Hex / Sector Inspector</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 flex-1 overflow-auto">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-slate-400 text-xs">
              <div className="w-6 h-6 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
              <span>Reading sector data...</span>
            </div>
          ) : activeTab === 'hex' ? (
            renderHexInspector()
          ) : cat === 'image' ? (
            renderImagePreview()
          ) : (
            renderTextPreview()
          )}
        </div>
      </div>
    </div>
  );
};
