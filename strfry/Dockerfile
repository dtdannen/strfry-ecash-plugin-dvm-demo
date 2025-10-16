FROM ubuntu:22.04

# Install build dependencies and Python
RUN apt-get update && apt-get install -y \
    git \
    g++ \
    make \
    libssl-dev \
    zlib1g-dev \
    liblmdb-dev \
    libflatbuffers-dev \
    libsecp256k1-dev \
    libzstd-dev \
    libyaml-perl \
    libtemplate-perl \
    libregexp-grammars-perl \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Clone and build strfry
WORKDIR /opt
RUN git clone https://github.com/hoytech/strfry && cd strfry/ && \
    git submodule update --init && \
    make setup-golpe && \
    make -j4

# Create directories for data and plugins
RUN mkdir -p /data/strfry-db /plugins

# Install Python dependencies for ecash plugin
COPY plugins/requirements.txt /tmp/plugin-requirements.txt
RUN pip3 install -r /tmp/plugin-requirements.txt

# Copy plugin files
COPY plugins/*.py /plugins/
RUN chmod +x /plugins/*.py

WORKDIR /opt/strfry

# Expose strfry relay port
EXPOSE 7777

# Copy configuration file (will be mounted from host)
# The default config will be used if none is provided
CMD ["./strfry", "relay"]
