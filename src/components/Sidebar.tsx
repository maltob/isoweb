import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Disc,
  Folder,
  FolderOpen,
  HardDrive,
  ShieldCheck,
} from 'lucide-react';
import { DiskImageInfo, VNode } from '../lib/types';
import { formatBytes } from '../lib/utils';

interface SidebarProps {
  root: VNode;
  currentPath: string;
  onNavigate: (path: string) => void;
  imageInfo: DiskImageInfo;
}

export const Sidebar: React.FC<SidebarProps> = ({
  root,
  currentPath,
  onNavigate,
  imageInfo,
}) => {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(['/']));

  const toggleExpand = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = new Set(expandedPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    setExpandedPaths(next);
  };

  const renderTreeItem = (node: VNode, depth: number = 0) => {
    if (!node.isDirectory) return null;

    const isExpanded = expandedPaths.has(node.path);
    const isSelected = currentPath === node.path;
    const subDirs = (node.children || []).filter((c) => c.isDirectory);
    const hasChildren = subDirs.length > 0;

    return (
      <div key={node.path} className="select-none">
        <div
          onClick={() => onNavigate(node.path)}
          style={{ paddingLeft: `${depth * 14 + 10}px` }}
          className={`flex items-center gap-1.5 py-1.5 pr-2 rounded-md text-xs cursor-pointer transition ${
            isSelected
              ? 'bg-sky-600/20 text-sky-400 font-medium'
              : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
          }`}
        >
          {hasChildren ? (
            <button
              onClick={(e) => toggleExpand(node.path, e)}
              className="p-0.5 hover:text-white text-slate-400 rounded transition"
            >
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
            </button>
          ) : (
            <span className="w-4" />
          )}

          {isSelected || isExpanded ? (
            <FolderOpen className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          ) : (
            <Folder className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          )}

          <span className="truncate flex-1">{node.name === '/' ? 'Root Directory' : node.name}</span>

          {node.children && node.children.length > 0 && (
            <span className="text-[10px] text-slate-400 px-1 py-0.2 bg-slate-800 rounded">
              {node.children.length}
            </span>
          )}
        </div>

        {isExpanded && hasChildren && (
          <div className="flex flex-col">
            {subDirs.map((dir) => renderTreeItem(dir, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="w-64 bg-slate-900/60 border-r border-slate-800 flex flex-col justify-between shrink-0 overflow-hidden">
      {/* Directory Hierarchy Header */}
      <div className="p-3 border-b border-slate-800/80 flex items-center justify-between text-xs font-semibold text-slate-400">
        <span>DIRECTORIES</span>
        <span className="text-[11px] font-normal text-slate-400">Tree View</span>
      </div>

      {/* Directory Tree */}
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {renderTreeItem(root)}
      </div>

      {/* Disk Specs Card */}
      <div className="p-3 border-t border-slate-800 bg-slate-950/40 text-[11px] text-slate-400 space-y-1.5">
        <div className="flex items-center justify-between font-medium text-slate-300">
          <span className="flex items-center gap-1.5">
            {imageInfo.format === 'iso' ? (
              <Disc className="w-3.5 h-3.5 text-sky-400" />
            ) : (
              <HardDrive className="w-3.5 h-3.5 text-amber-400" />
            )}
            {imageInfo.formatName}
          </span>
          <span className="text-slate-400">{formatBytes(root.size)}</span>
        </div>

        <div className="flex items-center justify-between text-slate-400">
          <span>Sector Size:</span>
          <span className="font-mono text-slate-300">{imageInfo.sectorSize} B</span>
        </div>

        <div className="flex items-center justify-between text-slate-400">
          <span>Total Sectors:</span>
          <span className="font-mono text-slate-300">{imageInfo.totalSectors.toLocaleString()}</span>
        </div>

        {imageInfo.isBootable && (
          <div className="flex items-center gap-1.5 text-emerald-400 font-medium pt-1 border-t border-slate-800/60">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Bootable ({imageInfo.bootSystem || 'Yes'})</span>
          </div>
        )}
      </div>
    </aside>
  );
};
