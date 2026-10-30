// Small helpers shared by the /api/v1 routes.
//
// HttpError lets a route say "answer 409 with this message and code" from
// anywhere, including inside a transaction. wrap() turns it into the JSON
// response, and passes anything unexpected on to the central error handler
// (which hides details in production).

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) })
    }
    next(err)
  })
