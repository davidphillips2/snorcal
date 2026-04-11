interface JobCardProps {
  job: {
    id: string;
    engine: string;
    status: string;
    progress: number;
    currentStep?: string;
    gcodeSize?: number;
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
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded text-xs font-medium text-white ${STATUS_COLORS[job.status] || 'bg-gray-600'}`}>
            {job.status}
          </span>
          <span className="text-sm text-gray-400">{ENGINE_LABELS[job.engine] || job.engine}</span>
        </div>
        <span className="text-xs text-gray-500">{new Date(job.createdAt).toLocaleString()}</span>
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
        <p className="text-xs text-red-400 mt-1">{job.errorMessage}</p>
      )}

      {job.gcodeSize && (
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
