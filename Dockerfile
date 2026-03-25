FROM python:3.12-slim

WORKDIR /app

# Install backend deps
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend
COPY backend/ .

# Copy frontend as static files
COPY frontend/ /app/static/

ENV DATA_DIR=/data
ENV STATIC_DIR=/app/static
ENV JWT_SECRET=change-me-in-production

VOLUME ["/data"]
EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
