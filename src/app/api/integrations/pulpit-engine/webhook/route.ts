export async function POST() {
  return Response.json(
    {
      error: {
        code: "NOT_AVAILABLE",
        message: "Pulpit Engine integration is reserved for a future phase.",
        retryable: false,
      },
    },
    { status: 501 },
  );
}
