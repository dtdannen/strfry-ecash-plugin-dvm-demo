FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for secp256k1
RUN apt-get update && apt-get install -y \
    pkg-config \
    libsecp256k1-dev \
    gcc \
    make \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY nip17_crypto.py .
COPY encrypted_ecash_echo_dvm.py .

# Create data directory for keys
RUN mkdir -p /data

CMD ["python", "encrypted_ecash_echo_dvm.py"]