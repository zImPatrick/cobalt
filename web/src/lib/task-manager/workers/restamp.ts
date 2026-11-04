import { restampFile } from "$lib/restamp";

const restamp = async (file: File) => {
    let result: Blob = file;

    // restamping is a best-effort fix, so it must never fail a download:
    // files that are fine, can't be fixed, or break something are passed through
    try {
        const { analysis, output } = await restampFile(file);

        if (output) {
            result = output;
        } else if (analysis.status === "unsupported") {
            console.log("restamp: passing the file through:", analysis.reason);
        }
    } catch (e) {
        console.error("error from the restamp worker, passing the file through:");
        console.error(e);
    }

    // nothing is written to storage: a fixed file is made of slices of the
    // input and a new header. it keeps the input's name, so that the input's
    // storage isn't removed while the result still needs it
    self.postMessage({
        cobaltRestampWorker: {
            result: new File([result], file.name, { type: file.type }),
        }
    });
}

self.onmessage = async (event: MessageEvent) => {
    const file = event.data.cobaltRestampWorker?.file;

    if (file instanceof File) {
        await restamp(file);
    } else {
        self.postMessage({
            cobaltRestampWorker: {
                error: "queue.restamp.no_file",
            }
        });
    }

    self.close();
}
