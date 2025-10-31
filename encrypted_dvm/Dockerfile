FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the encrypted DVM code and NIP-17 crypto library
COPY encrypted_echo_dvm.py nip17_crypto.py ./

# Create data directory for persistent keys
RUN mkdir -p /data

# Run the encrypted DVM with unbuffered output
CMD ["python", "-u", "encrypted_echo_dvm.py"]