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
    createdAt: string;
  };
  onCancel?: (jobId: string) => void;
  onDownload?: (jobId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-yellow-600',
  running: 'bg-blue-600',
  completed: 'bg-green-600',
  failed: 'bg-red-600',
  cancelled: 'bg-gray-600',
};

const ENGINE_LABELS: Record<string, string> = {
  orcaslicer: 'OrcaSlicer',
  bambustudio: 'BambuStudio',
  snapmaker_orca: 'Snapmaker Orca',
};

export function JobCard({ job, onCancel, onDownload }: JobCardProps) {
  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium text-white ${STATUS_COLORS[job.status] || 'bg-gray-600'}`}>
            {job.status}
          </span>
          <span className="text-sm text-white truncate">{job.modelName || ENGINE_LABELS[job.engine] || job.engine}</span>
        </div>
        <span className="text-xs text-gray-500 shrink-0 ml-2">{new Date(job.createdAt).toLocaleString()}</span>
      </div>

      {/* Progress bar */}
      {(job.status === 'running' || job.status === 'completed') && (
        <div className="mb-2">
          <div className="flex justify-between text-xs text-gray-400 mb-1">
            <span>{job.currentStep || job.status}</span>
            <span>{job.progress}%</span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${
                job.status === 'completed' ? 'bg-green-500' : 'bg-blue-500'
              }`}
              style={{ width: `${job.progress}%` }}
            />
          </div>
        </div>
      )}

      {job.errorMessage && (
        <p className="text-xs text-red-400 mt-1 break-all">{job.errorMessage}</p>
      )}

      {/* Estimates */}
      {job.status === 'completed' && (job.estimatedTime || job.filamentUsedG || job.filamentCost !== undefined) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-gray-300">
          {job.estimatedTime && (
            <span className="flex items-center gap-1">
              <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {job.estimatedTime}
            </span>
          )}
          {job.filamentUsedG !== undefined && job.filamentUsedG > 0 && (
            <span className="flex items-center gap-1">
              <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
              {job.filamentUsedG < 1 ? `${(job.filamentUsedG * 1000).toFixed(0)}mg` : `${job.filamentUsedG.toFixed(1)}g`}
            </span>
          )}
          {job.filamentCost !== undefined && job.filamentCost > 0 && (
            <span className="flex items-center gap-1">
              <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
              </svg>
              ${job.filamentCost.toFixed(2)}
            </span>
          )}
          {job.gcodeSize && (
            <span>{(job.gcodeSize / 1024).toFixed(1)} KB</span>
          )}
        </div>
      )}

      {job.status === 'completed' && !job.estimatedTime && job.gcodeSize && (
        <p className="text-xs text-gray-500 mt-1">G-code: {(job.gcodeSize / 1024).toFixed(1)} KB</p>
      )}

      <div className="flex gap-2 mt-3">
        {job.status === 'running' && onCancel && (
          <button
            onClick={() => onCancel(job.id)}
            className="px-3 py-1 text-xs rounded bg-red-600/20 text-red-400 hover:bg-red-600/30 transition"
          >
            Cancel
          </button>
        )}
        {job.status === 'completed' && onDownload && (
          <button
            onClick={() => onDownload(job.id)}
            className="px-3 py-1 text-xs rounded bg-green-600/20 text-green-400 hover:bg-green-600/30 transition"
          >
            Download G-code
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
}

export function JobList({ jobs, onCancel, onDownload }: JobListProps) {
  if (jobs.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        No slicing jobs yet
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {jobs.map((job) => (
        <JobCard key={job.id} job={job} onCancel={onCancel} onDownload={onDownload} />
      ))}
    </div>
  );
}
