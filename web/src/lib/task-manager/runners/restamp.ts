import RestampWorker from "$lib/task-manager/workers/restamp?worker";

import { removeWorkerFromQueue } from "$lib/state/task-manager/current-tasks";
import { pipelineTaskDone, itemError, queue } from "$lib/state/task-manager/queue";

import type { CobaltQueue, UUID } from "$lib/types/queue";

export const runRestampWorker = async (workerId: UUID, parentId: UUID, file: File) => {
    let worker: Worker | undefined;
    let killed = false;
    let unsubscribe = () => {};

    const kill = () => {
        killed = true;
        unsubscribe();
        worker?.terminate();
    }

    // restamping is optional, so pass the file through instead of failing
    const passThrough = (e: unknown) => {
        if (killed) return;
        kill();

        console.error("restamp worker failed, passing the file through:", e);
        return pipelineTaskDone(parentId, workerId, file);
    }

    // stop if the item was removed, failed in another worker,
    // or was replaced by a retry with the same id
    unsubscribe = queue.subscribe((queue: CobaltQueue) => {
        const parent = queue[parentId];
        const isCurrent = parent?.state === "running"
            && parent.pipeline.some(w => w.workerId === workerId);

        if (!killed && !isCurrent) {
            kill();
            removeWorkerFromQueue(workerId);
        }
    });

    // the subscriber runs right away, before unsubscribe is assigned
    if (killed) return unsubscribe();

    try {
        worker = new RestampWorker();

        worker.onerror = passThrough;

        worker.onmessage = (event) => {
            const eventData = event.data.cobaltRestampWorker;
            if (!eventData || killed) return;

            if (eventData.result) {
                kill();
                return pipelineTaskDone(
                    parentId,
                    workerId,
                    eventData.result,
                );
            }

            if (eventData.error) {
                kill();
                return itemError(parentId, workerId, eventData.error);
            }
        }

        worker.postMessage({
            cobaltRestampWorker: {
                file
            }
        });
    } catch (e) {
        return passThrough(e);
    }
}
