import { Skeleton } from "@/components/ui/skeleton";

// ── Generic building blocks ──────────────────────────────────────────────────

const StatCards = ({ count = 4 }: { count?: number }) => (
  <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-${count} gap-4`}>
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
        <div className="flex justify-between items-start">
          <Skeleton className="h-9 w-9 rounded-lg" />
          <Skeleton className="h-5 w-12 rounded-full" />
        </div>
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-4 w-32" />
      </div>
    ))}
  </div>
);

const TableRows = ({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) => (
  <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
    {/* Table header */}
    <div className="px-4 py-3 border-b border-gray-100 flex gap-4">
      {Array.from({ length: cols }).map((_, i) => (
        <Skeleton key={i} className={`h-4 rounded ${i === 0 ? "w-32" : i === cols - 1 ? "w-16 ml-auto" : "w-24"}`} />
      ))}
    </div>
    {/* Rows */}
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="px-4 py-3.5 border-b border-gray-50 flex items-center gap-4">
        <Skeleton className="h-8 w-8 rounded-full shrink-0" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-6 w-16 rounded-full ml-auto" />
        <Skeleton className="h-8 w-16 rounded-md" />
      </div>
    ))}
  </div>
);

const PageHeader = ({ hasButton = false }: { hasButton?: boolean }) => (
  <div className="flex justify-between items-start">
    <div className="space-y-2">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-72" />
    </div>
    {hasButton && <Skeleton className="h-9 w-32 rounded-lg" />}
  </div>
);

// ── Page-level skeletons ─────────────────────────────────────────────────────

/** Admin Dashboard — stats + overview cards + todo + tabs + charts */
export const AdminDashboardSkeleton = () => (
  <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
    {/* Header */}
    <div className="flex justify-between items-center">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-9 w-32 rounded-lg" />
    </div>

    {/* 4 stat cards */}
    <StatCards count={4} />

    {/* Overview + Todo row */}
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
      <div className="lg:col-span-3 bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        <Skeleton className="h-5 w-36" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="border border-gray-100 rounded-lg p-3 space-y-2">
              <Skeleton className="h-4 w-24" />
              {Array.from({ length: 3 }).map((_, j) => (
                <div key={j} className="flex justify-between">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-3 w-8" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
        <Skeleton className="h-5 w-28" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-20 rounded-full" />
          <Skeleton className="h-8 w-24 rounded-full" />
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    </div>

    {/* Invoice summary 3 cards */}
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="bg-white border border-gray-200 rounded-xl p-4 space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-3 w-36" />
        </div>
      ))}
    </div>

    {/* Tabs section */}
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="flex gap-2 px-4 pt-3 border-b border-gray-100">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-20 rounded-t-md" />
        ))}
      </div>
      <div className="p-4 space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full rounded-md" />
        ))}
      </div>
    </div>

    {/* Charts row */}
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <div className="lg:col-span-2 bg-white border border-gray-200 rounded-xl p-5 space-y-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-40 w-40 rounded-full mx-auto" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex justify-between">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-12" />
            </div>
          ))}
        </div>
      </div>
    </div>

    {/* Recent activity */}
    <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
      <Skeleton className="h-5 w-36" />
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-full shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-3 w-16 shrink-0" />
        </div>
      ))}
    </div>
  </div>
);

/** Generic table page skeleton — for all other admin pages */
export const AdminTablePageSkeleton = () => (
  <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
    <PageHeader hasButton />
    <div className="flex flex-wrap gap-3">
      <Skeleton className="h-9 w-56 rounded-lg" />
      <Skeleton className="h-9 w-28 rounded-lg" />
      <Skeleton className="h-9 w-28 rounded-lg" />
    </div>
    <TableRows rows={8} cols={5} />
  </div>
);
