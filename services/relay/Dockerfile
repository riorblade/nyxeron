# Static Go binary on an empty image: no shell, no libc, ~6 MB, nothing to patch but the binary itself.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/app .

FROM scratch
# CA roots for outbound HTTPS (the api calls Binance); harmless for the relay.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /out/app /app
USER 65534:65534
ENTRYPOINT ["/app"]
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD ["/app", "-healthcheck"]
