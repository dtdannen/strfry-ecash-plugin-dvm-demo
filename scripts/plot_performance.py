#!/usr/bin/env python3
"""
Performance Visualization Script for DVM Ecash Plugin

This script generates 4 publication-ready charts from performance test data:
1. Sequential Performance Comparison (Bar Chart)
2. Parallel Performance RTT Comparison (Bar Chart with Log Scale)
3. Throughput vs Latency Scatter Plot
4. Ecash Performance Under Different Delays (Line Chart)

Usage:
    python scripts/plot_performance.py
"""

import json
import re
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker
import numpy as np
from pathlib import Path

# Set publication-ready style
plt.style.use('seaborn-v0_8-darkgrid')
plt.rcParams['figure.dpi'] = 300
plt.rcParams['savefig.dpi'] = 300
plt.rcParams['font.size'] = 10
plt.rcParams['font.family'] = 'sans-serif'
plt.rcParams['axes.labelsize'] = 11
plt.rcParams['axes.titlesize'] = 12
plt.rcParams['xtick.labelsize'] = 9
plt.rcParams['ytick.labelsize'] = 9
plt.rcParams['legend.fontsize'] = 9

# Color scheme
COLORS = {
    'plain': '#3498db',      # Blue
    'encrypted': '#2ecc71',  # Green
    'ecash': '#9b59b6'       # Purple
}

def parse_results_file(filepath='data/results_24OCT2025.txt'):
    """Parse the performance test results file."""
    with open(filepath, 'r') as f:
        content = f.read()

    data = {
        'sequential': {},
        'parallel': {}
    }

    # Parse sequential data
    sequential_section = re.search(r'sequential data:(.*?)Parallel tests:', content, re.DOTALL)
    if sequential_section:
        seq_text = sequential_section.group(1)

        # Plain sequential
        plain_match = re.search(r'🔓 Plain Performance Test.*?Median RTT\s+(\d+)\s+ms.*?Avg RTT\s+(\d+)\s+ms.*?P95 RTT\s+(\d+)\s+ms', seq_text, re.DOTALL)
        if plain_match:
            data['sequential']['plain'] = {
                'median': int(plain_match.group(1)),
                'avg': int(plain_match.group(2)),
                'p95': int(plain_match.group(3))
            }

        # Encrypted sequential
        enc_match = re.search(r'🔐 Encrypted Performance Test.*?Median RTT\s+(\d+)\s+ms.*?Avg RTT\s+(\d+)\s+ms.*?P95 RTT\s+(\d+)\s+ms', seq_text, re.DOTALL)
        if enc_match:
            data['sequential']['encrypted'] = {
                'median': int(enc_match.group(1)),
                'avg': int(enc_match.group(2)),
                'p95': int(enc_match.group(3))
            }

        # Ecash sequential
        ecash_match = re.search(r'Ecash Performance Test.*?Median RTT\s+(\d+)\s+ms.*?Avg RTT\s+(\d+)\s+ms.*?P95 RTT\s+(\d+)\s+ms', seq_text, re.DOTALL)
        if ecash_match:
            data['sequential']['ecash'] = {
                'median': int(ecash_match.group(1)),
                'avg': int(ecash_match.group(2)),
                'p95': int(ecash_match.group(3))
            }

    # Parse parallel data
    parallel_section = re.search(r'Parallel tests:(.*)', content, re.DOTALL)
    if parallel_section:
        par_text = parallel_section.group(1)

        # Find all JSON objects
        json_objects = re.findall(r'\{[^}]+\}', par_text)

        for json_str in json_objects:
            try:
                obj = json.loads(json_str)
                dvm_type = obj.get('dvmType')

                if dvm_type == 'plain':
                    data['parallel']['plain'] = obj
                elif dvm_type == 'encrypted':
                    data['parallel']['encrypted'] = obj
                elif dvm_type == 'ecash':
                    # Look for delay annotation before this JSON
                    # Find the position of this JSON in the text
                    json_pos = par_text.find(json_str)
                    preceding_text = par_text[max(0, json_pos-200):json_pos]

                    delay_match = re.search(r'delay of (\d+)ms', preceding_text)
                    if delay_match:
                        delay = int(delay_match.group(1))
                        if 'ecash_delays' not in data['parallel']:
                            data['parallel']['ecash_delays'] = {}
                        data['parallel']['ecash_delays'][delay] = obj
                    else:
                        # Check for "This is with a delay of Xms"
                        delay_match = re.search(r'This is with a delay of (\d+)ms', preceding_text)
                        if delay_match:
                            delay = int(delay_match.group(1))
                            if 'ecash_delays' not in data['parallel']:
                                data['parallel']['ecash_delays'] = {}
                            data['parallel']['ecash_delays'][delay] = obj
                        else:
                            # Default to 5ms if no delay specified
                            if 'ecash_delays' not in data['parallel']:
                                data['parallel']['ecash_delays'] = {}
                            if 5 not in data['parallel']['ecash_delays']:
                                data['parallel']['ecash_delays'][5] = obj
            except json.JSONDecodeError:
                continue

    return data


def chart1_sequential_comparison(data, output_dir='output'):
    """Chart 1: Sequential Performance Comparison (Bar Chart)"""
    fig, ax = plt.subplots(figsize=(10, 6))

    dvm_types = ['Plain', 'Encrypted', 'Ecash']
    metrics = ['median', 'avg', 'p95']
    metric_labels = ['Median RTT', 'Avg RTT', 'P95 RTT']

    x = np.arange(len(dvm_types))
    width = 0.18

    for i, (metric, label) in enumerate(zip(metrics, metric_labels)):
        values = [
            data['sequential']['plain'][metric],
            data['sequential']['encrypted'][metric],
            data['sequential']['ecash'][metric]
        ]
        offset = (i - 1) * width
        bars = ax.bar(x + offset, values, width, label=label, alpha=0.8)

        # Add value labels on bars
        for bar in bars:
            height = bar.get_height()
            ax.text(bar.get_x() + bar.get_width()/2., height,
                   f'{int(height)}',
                   ha='center', va='bottom', fontsize=8)

    ax.set_xlabel('DVM Type')
    ax.set_ylabel('Latency (ms)')
    ax.set_title('Sequential Performance Comparison\n(Single User Experience - No Load)', fontweight='bold')
    ax.set_xticks(x)
    ax.set_xticklabels(dvm_types)
    ax.legend()
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    Path(output_dir).mkdir(exist_ok=True)
    plt.savefig(f'{output_dir}/chart1_sequential_comparison.png', bbox_inches='tight')
    plt.savefig(f'{output_dir}/chart1_sequential_comparison.svg', bbox_inches='tight')
    print(f"✅ Chart 1 saved to {output_dir}/chart1_sequential_comparison.png")
    plt.close()


def chart1_style1_clean_minimal(data, output_dir='output'):
    """Chart 1 Style 1: Clean Minimal (White background, no grid)"""
    # Temporarily override style
    with plt.style.context('seaborn-v0_8-white'):
        fig, ax = plt.subplots(figsize=(10, 6))
        fig.patch.set_facecolor('white')
        ax.set_facecolor('white')

        dvm_types = ['Plain', 'Encrypted', 'Ecash']
        metrics = ['median', 'avg', 'p95']

        # Vibrant gradient colors for social media
        colors = ['#FF6B6B', '#4ECDC4', '#FFE66D']

        x = np.arange(len(dvm_types))
        width = 0.18

        for i, metric in enumerate(metrics):
            values = [
                data['sequential']['plain'][metric],
                data['sequential']['encrypted'][metric],
                data['sequential']['ecash'][metric]
            ]
            offset = (i - 1) * width
            bars = ax.bar(x + offset, values, width, label=metric.upper(),
                         color=colors[i], alpha=0.9, edgecolor='white', linewidth=2)

            # Add value labels on bars with larger font
            for bar in bars:
                height = bar.get_height()
                ax.text(bar.get_x() + bar.get_width()/2., height,
                       f'{int(height)}ms',
                       ha='center', va='bottom', fontsize=11, fontweight='bold')

        ax.set_xlabel('DVM Type', fontsize=14, fontweight='bold')
        ax.set_ylabel('Latency (ms)', fontsize=14, fontweight='bold')
        ax.set_title('Sequential Performance Comparison\nSingle User Experience - No Load',
                    fontsize=16, fontweight='bold', pad=20)
        ax.set_xticks(x)
        ax.set_xticklabels(dvm_types, fontsize=13, fontweight='bold')
        ax.legend(fontsize=11, frameon=False)
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        ax.tick_params(labelsize=11)

        plt.tight_layout()
        Path(output_dir).mkdir(exist_ok=True)
        plt.savefig(f'{output_dir}/chart1_style1_clean_minimal.png', bbox_inches='tight', facecolor='white')
        print(f"✅ Chart 1 Style 1 (Clean Minimal) saved")
        plt.close()


def chart1_style2_dark_mode(data, output_dir='output'):
    """Chart 1 Style 2: Dark Mode (Great for social media)"""
    with plt.style.context('dark_background'):
        fig, ax = plt.subplots(figsize=(10, 6))
        fig.patch.set_facecolor('#1a1a1a')
        ax.set_facecolor('#1a1a1a')

        dvm_types = ['Plain', 'Encrypted', 'Ecash']
        metrics = ['median', 'avg', 'p95']

        # Neon colors for dark mode
        colors = ['#00D9FF', '#FF3EA5', '#FFEA00']

        x = np.arange(len(dvm_types))
        width = 0.18

        for i, metric in enumerate(metrics):
            values = [
                data['sequential']['plain'][metric],
                data['sequential']['encrypted'][metric],
                data['sequential']['ecash'][metric]
            ]
            offset = (i - 1) * width
            bars = ax.bar(x + offset, values, width, label=metric.upper(),
                         color=colors[i], alpha=0.9, edgecolor='#333', linewidth=2)

            # Add value labels on bars
            for bar in bars:
                height = bar.get_height()
                ax.text(bar.get_x() + bar.get_width()/2., height,
                       f'{int(height)}ms',
                       ha='center', va='bottom', fontsize=11, fontweight='bold',
                       color='white')

        ax.set_xlabel('DVM Type', fontsize=14, fontweight='bold', color='white')
        ax.set_ylabel('Latency (ms)', fontsize=14, fontweight='bold', color='white')
        ax.set_title('Sequential Performance Comparison\nSingle User Experience - No Load',
                    fontsize=16, fontweight='bold', pad=20, color='white')
        ax.set_xticks(x)
        ax.set_xticklabels(dvm_types, fontsize=13, fontweight='bold')
        ax.legend(fontsize=11, frameon=False)
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        ax.spines['left'].set_color('#555')
        ax.spines['bottom'].set_color('#555')
        ax.tick_params(colors='white', labelsize=11)
        ax.grid(True, alpha=0.1, color='white')

        plt.tight_layout()
        Path(output_dir).mkdir(exist_ok=True)
        plt.savefig(f'{output_dir}/chart1_style2_dark_mode.png', bbox_inches='tight', facecolor='#1a1a1a')
        print(f"✅ Chart 1 Style 2 (Dark Mode) saved")
        plt.close()


def chart1_style3_gradient_bars(data, output_dir='output'):
    """Chart 1 Style 3: Gradient Bars with Shadows"""
    with plt.style.context('seaborn-v0_8-white'):
        fig, ax = plt.subplots(figsize=(10, 6))
        fig.patch.set_facecolor('#f8f9fa')
        ax.set_facecolor('#f8f9fa')

        dvm_types = ['Plain', 'Encrypted', 'Ecash']
        metrics = ['median', 'avg', 'p95']

        # Professional gradient colors
        colors = ['#667eea', '#f093fb', '#4facfe']

        x = np.arange(len(dvm_types))
        width = 0.18

        for i, metric in enumerate(metrics):
            values = [
                data['sequential']['plain'][metric],
                data['sequential']['encrypted'][metric],
                data['sequential']['ecash'][metric]
            ]
            offset = (i - 1) * width

            # Create bars with shadow effect
            bars = ax.bar(x + offset, values, width, label=metric.upper(),
                         color=colors[i], alpha=0.85, edgecolor='white', linewidth=2.5,
                         zorder=3)

            # Add value labels with background
            for bar in bars:
                height = bar.get_height()
                ax.text(bar.get_x() + bar.get_width()/2., height,
                       f'{int(height)}ms',
                       ha='center', va='bottom', fontsize=11, fontweight='bold',
                       bbox=dict(boxstyle='round,pad=0.4', facecolor='white',
                                edgecolor=colors[i], linewidth=2, alpha=0.9))

        ax.set_xlabel('DVM Type', fontsize=14, fontweight='bold', color='#2d3748')
        ax.set_ylabel('Latency (ms)', fontsize=14, fontweight='bold', color='#2d3748')
        ax.set_title('Sequential Performance Comparison\nSingle User Experience - No Load',
                    fontsize=16, fontweight='bold', pad=20, color='#1a202c')
        ax.set_xticks(x)
        ax.set_xticklabels(dvm_types, fontsize=13, fontweight='bold')
        ax.legend(fontsize=11, frameon=True, facecolor='white', edgecolor='#cbd5e0', shadow=True)
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        ax.spines['left'].set_color('#cbd5e0')
        ax.spines['bottom'].set_color('#cbd5e0')
        ax.tick_params(labelsize=11, color='#cbd5e0')
        ax.grid(True, alpha=0.2, linestyle='--', linewidth=1, color='#cbd5e0', zorder=0)

        plt.tight_layout()
        Path(output_dir).mkdir(exist_ok=True)
        plt.savefig(f'{output_dir}/chart1_style3_gradient_bars.png', bbox_inches='tight', facecolor='#f8f9fa')
        print(f"✅ Chart 1 Style 3 (Gradient Bars) saved")
        plt.close()


def chart2_parallel_rtt_comparison(data, output_dir='output'):
    """Chart 2: Parallel Performance RTT Comparison (Bar Chart with Log Scale)"""
    fig, ax = plt.subplots(figsize=(10, 6))

    dvm_types = ['Plain', 'Encrypted', 'Ecash\n(50ms delay)']

    # Use 50ms delay data for ecash if available, otherwise fall back to available delay
    ecash_data = data['parallel'].get('ecash_delays', {}).get(50)
    if not ecash_data:
        # Try to get any available delay data
        if data['parallel'].get('ecash_delays'):
            ecash_data = list(data['parallel']['ecash_delays'].values())[0]

    avg_rtts = [
        data['parallel']['plain']['avgRTT'],
        data['parallel']['encrypted']['avgRTT'],
        ecash_data['avgRTT'] if ecash_data else 0
    ]

    colors_list = [COLORS['plain'], COLORS['encrypted'], COLORS['ecash']]

    bars = ax.bar(dvm_types, avg_rtts, color=colors_list, alpha=0.8, edgecolor='black', linewidth=1.5)

    # Add value labels on bars
    for bar, value in zip(bars, avg_rtts):
        height = bar.get_height()
        # Format large numbers with comma separators
        label = f'{int(value):,}' if value >= 1000 else f'{int(value)}'
        ax.text(bar.get_x() + bar.get_width()/2., height,
               f'{label} ms',
               ha='center', va='bottom', fontsize=9, fontweight='bold')

    ax.set_ylabel('Average RTT (ms, log scale)')
    ax.set_title('Parallel Performance Under Load (1000 concurrent requests)\nShowing Architectural Bottleneck in Ecash System', fontweight='bold')
    ax.set_yscale('log')
    ax.grid(True, alpha=0.3, which='both')

    # Format y-axis ticks
    ax.yaxis.set_major_formatter(ticker.FuncFormatter(lambda y, _: f'{int(y):,}'))

    plt.tight_layout()
    Path(output_dir).mkdir(exist_ok=True)
    plt.savefig(f'{output_dir}/chart2_parallel_rtt_comparison.png', bbox_inches='tight')
    plt.savefig(f'{output_dir}/chart2_parallel_rtt_comparison.svg', bbox_inches='tight')
    print(f"✅ Chart 2 saved to {output_dir}/chart2_parallel_rtt_comparison.png")
    plt.close()


def chart3_throughput_vs_latency(data, output_dir='output'):
    """Chart 3: Throughput vs Latency Scatter Plot"""
    fig, ax = plt.subplots(figsize=(10, 6))

    # Extract data points
    points = {
        'Plain': {
            'throughput': data['parallel']['plain']['throughput'],
            'rtt': data['parallel']['plain']['avgRTT']
        },
        'Encrypted': {
            'throughput': data['parallel']['encrypted']['throughput'],
            'rtt': data['parallel']['encrypted']['avgRTT']
        }
    }

    # Add ecash delays if available
    if 'ecash_delays' in data['parallel']:
        for delay, ecash_data in data['parallel']['ecash_delays'].items():
            points[f'Ecash ({delay}ms)'] = {
                'throughput': ecash_data.get('throughput', 0),
                'rtt': ecash_data['avgRTT']
            }

    # Plot points
    for label, point in points.items():
        color = COLORS['plain'] if 'Plain' in label else \
                COLORS['encrypted'] if 'Encrypted' in label else \
                COLORS['ecash']

        marker = 'o' if 'Ecash' not in label else 's'
        size = 200 if 'Ecash' not in label else 150

        ax.scatter(point['throughput'], point['rtt'],
                  s=size, c=[color], alpha=0.7,
                  edgecolors='black', linewidth=1.5,
                  marker=marker, label=label)

        # Add labels
        offset_x = 2 if 'Plain' not in label else -5
        offset_y = point['rtt'] * 0.1
        ax.annotate(label,
                   (point['throughput'], point['rtt']),
                   xytext=(offset_x, offset_y),
                   textcoords='offset points',
                   fontsize=8,
                   bbox=dict(boxstyle='round,pad=0.3', facecolor=color, alpha=0.3))

    ax.set_xlabel('Throughput (requests/second)')
    ax.set_ylabel('Average RTT (ms, log scale)')
    ax.set_title('Throughput vs Latency Tradeoff\n(Parallel Mode - 1000 requests)', fontweight='bold')
    ax.set_yscale('log')
    ax.grid(True, alpha=0.3, which='both')
    ax.yaxis.set_major_formatter(ticker.FuncFormatter(lambda y, _: f'{int(y):,}'))

    plt.tight_layout()
    Path(output_dir).mkdir(exist_ok=True)
    plt.savefig(f'{output_dir}/chart3_throughput_vs_latency.png', bbox_inches='tight')
    plt.savefig(f'{output_dir}/chart3_throughput_vs_latency.svg', bbox_inches='tight')
    print(f"✅ Chart 3 saved to {output_dir}/chart3_throughput_vs_latency.png")
    plt.close()


def chart4_ecash_delay_impact(data, output_dir='output'):
    """Chart 4: Ecash Performance Under Different Delays"""
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 6))

    if 'ecash_delays' not in data['parallel'] or not data['parallel']['ecash_delays']:
        print("⚠️  No ecash delay data available for Chart 4")
        plt.close()
        return

    delays = sorted(data['parallel']['ecash_delays'].keys())
    rtts = [data['parallel']['ecash_delays'][d]['avgRTT'] for d in delays]
    throughputs = [data['parallel']['ecash_delays'][d].get('throughput', 0) for d in delays]

    # Chart 4a: RTT vs Delay
    ax1.plot(delays, rtts, marker='o', linewidth=2.5, markersize=10,
             color=COLORS['ecash'], markerfacecolor=COLORS['ecash'],
             markeredgecolor='black', markeredgewidth=1.5)

    for delay, rtt in zip(delays, rtts):
        label = f'{int(rtt):,}' if rtt >= 1000 else f'{int(rtt)}'
        ax1.annotate(f'{label} ms',
                    (delay, rtt),
                    xytext=(0, 10),
                    textcoords='offset points',
                    ha='center',
                    fontsize=8,
                    bbox=dict(boxstyle='round,pad=0.3', facecolor=COLORS['ecash'], alpha=0.3))

    ax1.set_xlabel('Request Delay (ms)')
    ax1.set_ylabel('Average RTT (ms, log scale)')
    ax1.set_title('Impact of Request Delay on Latency', fontweight='bold')
    ax1.set_yscale('log')
    ax1.grid(True, alpha=0.3, which='both')
    ax1.yaxis.set_major_formatter(ticker.FuncFormatter(lambda y, _: f'{int(y):,}'))

    # Chart 4b: Throughput vs Delay
    ax2.plot(delays, throughputs, marker='s', linewidth=2.5, markersize=10,
             color=COLORS['ecash'], markerfacecolor=COLORS['ecash'],
             markeredgecolor='black', markeredgewidth=1.5)

    for delay, throughput in zip(delays, throughputs):
        ax2.annotate(f'{throughput:.1f} req/s',
                    (delay, throughput),
                    xytext=(0, 10),
                    textcoords='offset points',
                    ha='center',
                    fontsize=8,
                    bbox=dict(boxstyle='round,pad=0.3', facecolor=COLORS['ecash'], alpha=0.3))

    ax2.set_xlabel('Request Delay (ms)')
    ax2.set_ylabel('Throughput (requests/second)')
    ax2.set_title('Impact of Request Delay on Throughput', fontweight='bold')
    ax2.grid(True, alpha=0.3)

    plt.suptitle('Ecash Performance Under Different Request Delays\n(Parallel Mode - 1000 requests)',
                 fontweight='bold', fontsize=13, y=1.02)

    plt.tight_layout()
    Path(output_dir).mkdir(exist_ok=True)
    plt.savefig(f'{output_dir}/chart4_ecash_delay_impact.png', bbox_inches='tight')
    plt.savefig(f'{output_dir}/chart4_ecash_delay_impact.svg', bbox_inches='tight')
    print(f"✅ Chart 4 saved to {output_dir}/chart4_ecash_delay_impact.png")
    plt.close()


def main():
    print("🎨 Generating Performance Visualizations...\n")

    # Parse data
    data = parse_results_file()

    print("📊 Data Summary:")
    print(f"  Sequential tests: {len(data['sequential'])} DVM types")
    print(f"  Parallel tests: {len(data['parallel'])} DVM types")
    if 'ecash_delays' in data['parallel']:
        print(f"  Ecash delay variations: {len(data['parallel']['ecash_delays'])} data points")
    print()

    # Generate charts
    print("📈 Generating Chart 1 variations for social media...")
    chart1_sequential_comparison(data)
    chart1_style1_clean_minimal(data)
    chart1_style2_dark_mode(data)
    chart1_style3_gradient_bars(data)

    print("\n📈 Generating other charts...")
    chart2_parallel_rtt_comparison(data)
    chart3_throughput_vs_latency(data)
    chart4_ecash_delay_impact(data)

    print("\n✨ All charts generated successfully!")
    print("   Output directory: output/")
    print("   Files: PNG and SVG formats")
    print("\n🎨 Chart 1 Social Media Styles:")
    print("   - chart1_style1_clean_minimal.png (Vibrant colors, white background)")
    print("   - chart1_style2_dark_mode.png (Neon colors, dark background)")
    print("   - chart1_style3_gradient_bars.png (Professional gradients with shadows)")


if __name__ == '__main__':
    main()
