import { createUploadthing, type FileRouter } from 'uploadthing/next';

const f = createUploadthing();

export const ourFileRouter = {
  puzzleUploader: f({ image: { maxFileSize: '8MB', maxFileCount: 1 } })
    .middleware(async () => {
      // Add auth here when ready (e.g. verify session token).
      return {};
    })
    .onUploadComplete(async ({ file }) => {
      // file.key is the UploadThing file key — used as the session ID in /s/[id]
      console.log('Upload complete:', file.key, file.url);
      return { key: file.key, url: file.url };
    }),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter;
