type BackgroundContext = {
	readonly executionCtx: {
		waitUntil(promise: Promise<unknown>): void;
	};
};

export async function runInBackground(
	context: BackgroundContext,
	task: Promise<unknown>,
): Promise<void> {
	const handled = task.catch((error: unknown) => {
		console.error("Background task failed", error);
	});
	try {
		context.executionCtx.waitUntil(handled);
	} catch {
		await handled;
	}
}
