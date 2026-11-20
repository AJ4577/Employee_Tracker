import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatInTz, type UserNotification } from "@kisanroute/shared";
import { supabase } from "../lib/supabase";
import { must, rpc } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Empty, ErrorState, Loading, PageHeader } from "../ui/ui";

export function NotificationsPage({ base }: { base: "/admin" | "/staff" }) {
  const { me, tz, refreshMe } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: () =>
      must<UserNotification[]>(
        supabase.from("user_notifications").select("id,type,visit_id,title,body,read_at,created_at").eq("recipient_id", me!.profile.id).order("created_at", { ascending: false }).limit(100),
      ),
  });
  const mark = useMutation({
    mutationFn: (ids: string[] | null) => rpc<number>("mark_notifications_read", { p_ids: ids }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      refreshMe();
    },
  });
  return (
    <>
      <PageHeader
        title="Notifications"
        actions={
          <Button variant="secondary" onClick={() => mark.mutate(null)} busy={mark.isPending} disabled={!q.data?.some((n) => !n.read_at)}>
            Mark all read
          </Button>
        }
      />
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? <Empty title="No notifications yet" /> : (
        <ul className="list">
          {q.data.map((n) => (
            <li key={n.id} className={`list-item ${n.read_at ? "" : "unread"}`}>
              <div>
                <strong>{n.title}</strong>
                {!n.read_at ? <span className="badge badge-assigned">New</span> : null}
                <p className="muted small">{n.body}</p>
                <p className="muted small">{formatInTz(n.created_at, tz)}</p>
              </div>
              <div className="row">
                {n.visit_id ? (
                  <Link className="btn btn-secondary btn-sm" to={`${base}/visits/${n.visit_id}`} onClick={() => !n.read_at && mark.mutate([n.id])}>
                    Open visit
                  </Link>
                ) : null}
                {!n.read_at ? (
                  <Button variant="ghost" className="btn-sm" onClick={() => mark.mutate([n.id])}>
                    Mark read
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
