import { AutoRouter, cors } from 'itty-router';
import { INSTANCE } from './drive';

const { preflight, corsify } = cors();

const router = AutoRouter({
	before: [preflight],
	finally: [corsify],
});

router.get('*', async (req) => corsify(await INSTANCE.getFileByPath(req)));
router.put('*', async (req) => corsify(await INSTANCE.uploadFileByPath(req)));
router.delete('*', async (req) => corsify(await INSTANCE.removeFileByPath(req)));

// PROD ENVIRONMENT UNCOMMENT BELOW
export default router;

// DEV ENVIRONMENT UNCOMMENT BELOW
// export default { ...router };
