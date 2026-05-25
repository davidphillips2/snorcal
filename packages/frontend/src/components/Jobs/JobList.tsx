interface JobCardProps {
  job: {
    id: string;
    modelName?: string;
    engine: string;
    status: string;
    progress: number;
    currentStep?: string;
    gcodeSize?: number;
    estimatedTime?: string;
    filamentUsedG?: number;
    filamentCost?: number;
    errorMessage?: string;
    plateIndex?: number;
    createdAt: string;
  };
  onCancel?: (jobId: string) => void;
  onDownload?: (jobId: string) => void;
  onDownloadThreemf?: (jobId: string) => void;
  onPreview?: (jobId: string) => void;
  onSendToPrinter?: (jobId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-yellow-500',
  running: 'bg-blue-500',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  cancelled: 'bg-gray-500',
};

const ENGINE_LABELS: Record<string, string> = {
  orcaslicer: 'OrcaSlicer',
  bambustudio: 'BambuStudio',
  snapmaker_orca: 'Snapmaker Orca',
};

export function JobCard({ job, onCancel, onDownload, onDownloadThreemf, onPreview, onSendToPrinter }: JobCardProps) {
  return (
    <div className="bg-gray-700/40 rounded-lg p-2.5 border border-gray-600/50">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`shrink-0 w-2 h-2 rounded-full ${STATUS_COLORS[job.status] || 'bg-gray-500'}`} />
          <span className="text-xs text-white truncate">{job.modelName || ENGINE_LABELS[job.engine] || job.engine}</span>
          {job.plateIndex != null && (
            <span className="shrink-0 px-1 py-0.5 rounded text-[10px] font-medium bg-gray-600 text-gray-300">P{job.plateIndex}</span>
          )}
        </div>
        <span className="text-[10px] text-gray-500 shrink-0 ml-2">{new Date(job.createdAt).toLocaleTimeString()}</span>
      </div>

      {/* Progress bar */}
      {(job.status === 'running' || job.status === 'completed') && (
        <div className="mb-1.5">
          <div className="flex justify-between text-[10px] text-gray-400 mb-0.5">
            <span>{job.currentStep || job.status}</span>
            <span>{job.progress}%</span>
          </div>
          <div className="w-full bg-gray-600 rounded-full h-1">
            <div
              className={`h-1 rounded-full transition-all ${
                job.status === 'completed' ? 'bg-green-500' : 'bg-blue-500'
              }`}
              style={{ width: `${job.progress}%` }}
            />
          </div>
        </div>
      )}

      {job.errorMessage && (
        <p className="text-[10px] text-red-400 mt-1 break-all">{job.errorMessage}</p>
      )}

      {/* Estimates */}
      {job.status === 'completed' && (job.estimatedTime || job.filamentUsedG || job.filamentCost !== undefined) && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[10px] text-gray-400">
          {job.estimatedTime && <span>{job.estimatedTime}</span>}
          {job.filamentUsedG !== undefined && job.filamentUsedG > 0 && (
            <span>{job.filamentUsedG < 1 ? `${(job.filamentUsedG * 1000).toFixed(0)}mg` : `${job.filamentUsedG.toFixed(1)}g`}</span>
          )}
          {job.gcodeSize && <span>{(job.gcodeSize / 1024).toFixed(1)} KB</span>}
        </div>
      )}

      <div className="flex gap-1.5 mt-2">
        {job.status === 'running' && onCancel && (
          <button
            onClick={() => onCancel(job.id)}
            className="px-2 py-0.5 text-[10px] rounded bg-red-600/20 text-red-400 hover:bg-red-600/30 transition"
          >
            Cancel
          </button>
        )}
        {job.status === 'completed' && onDownload && (
          <button
            onClick={() => onDownload(job.id)}
            className="px-2 py-0.5 text-[10px] rounded bg-green-600/20 text-green-400 hover:bg-green-600/30 transition"
          >
            G-code
          </button>
        )}
        {job.status === 'completed' && onDownloadThreemf && (
          <button
            onClick={() => onDownloadThreemf(job.id)}
            className="px-2 py-0.5 text-[10px] rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition"
          >
            3MF
          </button>
        )}
        {job.status === 'completed' && onPreview && (
          <button
            onClick={() => onPreview(job.id)}
            className="px-2 py-0.5 text-[10px] rounded bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 transition"
          >
            Preview
          </button>
        )}
        {job.status === 'completed' && onSendToPrinter && (
          <button
            onClick={() => onSendToPrinter(job.id)}
            className="px-2 py-0.5 text-[10px] rounded bg-orange-600/20 text-orange-400 hover:bg-orange-600/30 transition"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}

interface JobListProps {
  jobs: Array<JobCardProps['job']>;
  onCancel?: (jobId: string) => void;
  onDownload?: (jobId: string) => void;
  onDownloadThreemf?: (jobId: string) => void;
  onPreview?: (jobId: string) => void;
  onSendToPrinter?: (jobId: string) => void;
}

export function JobList({ jobs, onCancel, onDownload, onDownloadThreemf, onPreview, onSendToPrinter }: JobListProps) {
  if (jobs.length === 0) {
    return (
      <div className="text-center py-4 text-gray-500 text-xs">
        No slicing jobs yet
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {jobs.map((job) => (
        <JobCard key={job.id} job={job} onCancel={onCancel} onDownload={onDownload} onDownloadThreemf={onDownloadThreemf} onPreview={onPreview} onSendToPrinter={onSendToPrinter} />
      ))}
    </div>
  );
}
