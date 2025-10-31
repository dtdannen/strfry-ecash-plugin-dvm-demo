FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy DVM code
COPY echo_dvm.py .

# Create data directory for persistent keys
RUN mkdir -p /data

# Run the DVM with unbuffered output
CMD ["python", "-u", "echo_dvm.py"]
