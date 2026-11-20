import { useQuery } from "@tanstack/react-query";
import type { MyVisitListItem } from "@kisanroute/shared";
import { rpc } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Empty, ErrorState, Loading, PageHeader } from "../../ui/ui";
import { VisitCard } from "./MyDay";

export default function MyVisits({ scope }: { scope: "open" | "history" }) {
  const { tz } = useAuth();
  const q = useQuery({
    queryKey: ["my-visits", scope],
    queryFn: async () => {
      const r = await rpc<MyVisitListItem[]>("my_visits", { p_from: scope === "history" ? new Date(Date.now() - 90 * 86400e3).toISOString() : null, p_to: null, p_scope: scope });
      return scope === "history" ? [...r].reverse() : r;
    },
  });
  return (
    <>
      <PageHeader title={scope === "open" ? "My visits" : "History"} sub={scope === "history" ? "Completed and cancelled visits, last 90 days" : "All open visits assigned to you"} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? <Empty title={scope === "open" ? "No open visits" : "No past visits"} /> : (
        <ul className="visit-list">{q.data.map((v) => <VisitCard key={v.id} v={v} tz={tz} />)}</ul>
      )}
    </>
  );
}
