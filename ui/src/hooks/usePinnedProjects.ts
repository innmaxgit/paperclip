import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "../api/auth";
import {
  getPinnedProjectsStorageKey,
  PROJECT_PINNED_UPDATED_EVENT,
  type ProjectPinnedUpdatedDetail,
  readPinnedProjects,
  writePinnedProjects,
} from "../lib/project-order";
import { queryKeys } from "../lib/queryKeys";

export function usePinnedProjects(companyId: string | null | undefined) {
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const storageKey = useMemo(() => {
    if (!companyId) return null;
    return getPinnedProjectsStorageKey(companyId, currentUserId);
  }, [companyId, currentUserId]);

  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    if (!storageKey) return [];
    return readPinnedProjects(storageKey);
  });

  useEffect(() => {
    if (!storageKey) {
      setPinnedIds([]);
      return;
    }
    setPinnedIds(readPinnedProjects(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey) return;

    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      setPinnedIds(readPinnedProjects(storageKey));
    };
    const onCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<ProjectPinnedUpdatedDetail>).detail;
      if (!detail || detail.storageKey !== storageKey) return;
      setPinnedIds(detail.pinnedIds);
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(PROJECT_PINNED_UPDATED_EVENT, onCustomEvent);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(PROJECT_PINNED_UPDATED_EVENT, onCustomEvent);
    };
  }, [storageKey]);

  const togglePin = useCallback(
    (projectId: string) => {
      if (!storageKey) return;
      setPinnedIds((current) => {
        const next = current.includes(projectId)
          ? current.filter((id) => id !== projectId)
          : [...current, projectId];
        writePinnedProjects(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  const isPinned = useCallback((projectId: string) => pinnedIds.includes(projectId), [pinnedIds]);

  return { pinnedIds, togglePin, isPinned };
}
