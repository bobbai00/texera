# OIDC issuer stand-in for the Dashboard service (Step 0 proof only).
FROM python:3.12.14-slim-bookworm
RUN pip install --no-cache-dir cryptography==46.0.7
COPY issuer.py /app/issuer.py
USER 65534
EXPOSE 8080
CMD ["python", "-I", "/app/issuer.py"]
